import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { aiService } from '../../integrations/aiService';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { paged, paginate, param } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { authOf, can, requirePermission } from '../../middleware/auth';
import { enqueue } from '../../queues';
import { addIncidentEvent, incidentKey, requireIncident } from '../incidents';
import { assertWithinLimits, organizationLimits, usageToday } from './limits';
import { createBody, listQuery } from './validation';

/** HTTP routes under /api/v1/investigations. Starting one only queues it; the worker runs it. */
export const investigationsRouter = Router();

const listSelect = {
  id: true,
  question: true,
  status: true,
  provider: true,
  model: true,
  analysisMode: true,
  attemptedProvider: true,
  estimatedCostUsd: true,
  summary: true,
  confidence: true,
  outcome: true,
  error: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  createdById: true,
  incident: { select: { id: true, number: true, title: true, severity: true } },
  _count: { select: { evidence: true, hypotheses: true, steps: true } },
} satisfies Prisma.InvestigationSelect;

investigationsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = listQuery.parse(req.query);
  const where: Prisma.InvestigationWhereInput = { organizationId, ...(q.status ? { status: { in: q.status } } : {}), ...(q.incidentId ? { incidentId: q.incidentId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.investigation.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), select: listSelect }),
    prisma.investigation.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

/** Which model will run the next investigation; shown in the workspace before submitting. */
investigationsRouter.get('/ai-status', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  // ?verify=true asks the provider to confirm the key and model (a free metadata lookup).
  const verify = req.query.verify === 'true' && can(authOf(req), 'investigation:run');
  const usage = await usageToday(organizationId);
  const limits = organizationLimits();
  try {
    res.json({ reachable: true, ...(await aiService.status(verify)), usageToday: usage, organizationLimits: limits });
  } catch (err) {
    res.json({ reachable: false, detail: (err as Error).message, usageToday: usage, organizationLimits: limits });
  }
});

investigationsRouter.post('/', requirePermission('investigation:run'), async (req, res) => {
  const auth = authOf(req);
  const body = createBody.parse(req.body);
  const incident = body.incidentId ? await requireIncident(auth.organizationId, body.incidentId) : null;
  await assertWithinLimits(auth.organizationId);
  const investigation = await prisma.investigation.create({
    data: {
      organizationId: auth.organizationId,
      incidentId: incident?.id,
      question: body.question,
      timeWindowStart: body.timeWindow?.from,
      timeWindowEnd: body.timeWindow?.to,
      createdById: auth.userId,
    },
    select: listSelect,
  });
  await audit(req, 'investigation.start', 'investigation', investigation.id, { incident: incident ? incidentKey(incident.number) : null });
  if (incident) await addIncidentEvent(incident.id, 'investigation', `AI investigation started: "${body.question.slice(0, 200)}"`, auth, { investigationId: investigation.id });
  try {
    await enqueue('investigation', { investigationId: investigation.id });
  } catch (err) {
    // Never leave a row that looks queued when nothing will ever pick it up.
    await prisma.investigation.update({ where: { id: investigation.id }, data: { status: 'FAILED', error: (err as Error).message, completedAt: new Date() } });
    throw err;
  }
  res.status(202).json(await prisma.investigation.findUnique({ where: { id: investigation.id }, select: listSelect }));
});

investigationsRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const investigation = await prisma.investigation.findFirst({
    where: { id: param(req.params.id), organizationId },
    include: {
      incident: { select: { id: true, number: true, title: true, severity: true, status: true } },
      steps: { orderBy: { index: 'asc' } },
      evidence: { orderBy: { createdAt: 'asc' } },
      hypotheses: { orderBy: { rank: 'asc' } },
      remediations: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, type: true, risk: true, status: true, effect: true } },
    },
  });
  if (!investigation) throw notFound('Investigation');
  const creator = investigation.createdById ? await prisma.user.findUnique({ where: { id: investigation.createdById }, select: { id: true, name: true } }) : null;
  res.json({ ...investigation, createdBy: creator });
});

investigationsRouter.post('/:id/cancel', requirePermission('investigation:run'), async (req, res) => {
  const { organizationId } = authOf(req);
  const updated = await prisma.investigation.updateMany({
    where: { id: param(req.params.id), organizationId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (!updated.count) throw conflict('Only queued or running investigations can be cancelled');
  await audit(req, 'investigation.cancel', 'investigation', param(req.params.id));
  res.json({ id: param(req.params.id), status: 'CANCELLED' });
});
