import type { Incident, IncidentStatus, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { csv, paged, paginate, paginationQuery, param, timeParam } from '../lib/http';
import { notifyUsers } from '../lib/notify';
import { prisma } from '../lib/prisma';
import { type AuthContext, authOf, requirePermission } from '../middleware/auth';

const severity = z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']);
const status = z.enum(['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATED', 'RESOLVED', 'CLOSED']);
const ACTIVE: IncidentStatus[] = ['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATED'];

export const incidentKey = (number: number) => `INC-${number}`;

const createBody = z.object({
  title: z.string().trim().min(4).max(200),
  description: z.string().trim().max(10_000).nullable().optional(),
  severity: severity.default('SEV3'),
  environment: z.string().trim().min(1).max(40).default('production'),
  serviceIds: z.array(z.string()).max(30).default([]),
  assigneeId: z.string().nullable().optional(),
  commanderId: z.string().nullable().optional(),
  customerImpact: z.string().trim().max(2000).nullable().optional(),
  startedAt: z.coerce.date().optional(),
});

const updateBody = z.object({
  title: z.string().trim().min(4).max(200).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  severity: severity.optional(),
  status: status.optional(),
  assigneeId: z.string().nullable().optional(),
  commanderId: z.string().nullable().optional(),
  customerImpact: z.string().trim().max(2000).nullable().optional(),
  rootCause: z.string().trim().max(10_000).nullable().optional(),
  resolution: z.string().trim().max(10_000).nullable().optional(),
  serviceIds: z.array(z.string()).max(30).optional(),
  note: z.string().trim().max(2000).optional(),
});

const listQuery = paginationQuery.extend({
  q: z.string().trim().optional(),
  status: csv,
  severity: csv,
  service: z.string().optional(),
  assigneeId: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
  from: timeParam.optional(),
  to: timeParam.optional(),
  sort: z.enum(['startedAt', 'severity', 'updatedAt']).default('startedAt'),
});

const listInclude = {
  services: { select: { service: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.IncidentInclude;

type WithServices = Incident & { services: { service: { id: string; name: string; slug: string } }[] };

async function userNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

function present(incident: WithServices, names: Map<string, string>) {
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? 'Unknown user' } : null);
  return {
    ...incident,
    key: incidentKey(incident.number),
    services: incident.services.map((s) => s.service),
    assignee: person(incident.assigneeId),
    commander: person(incident.commanderId),
    createdBy: person(incident.createdById),
    durationMinutes: Math.round(((incident.resolvedAt ?? new Date()).getTime() - incident.startedAt.getTime()) / 60_000),
  };
}

async function assertMembers(organizationId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return;
  const count = await prisma.membership.count({ where: { organizationId, userId: { in: unique } } });
  if (count !== unique.length) throw badRequest('Assignee and commander must be members of this organisation');
}

async function assertServices(organizationId: string, ids: string[]) {
  if (!ids.length) return;
  const count = await prisma.service.count({ where: { organizationId, id: { in: ids } } });
  if (count !== new Set(ids).size) throw badRequest('One or more services do not exist');
}

export async function requireIncident(organizationId: string, idOrKey: string) {
  const number = /^(?:INC-)?(\d+)$/i.exec(idOrKey)?.[1];
  const incident = await prisma.incident.findFirst({
    where: { organizationId, ...(number ? { number: Number(number) } : { id: idOrKey }) },
    include: listInclude,
  });
  if (!incident) throw notFound('Incident');
  return incident;
}

export async function addIncidentEvent(
  incidentId: string,
  type: string,
  message: string,
  actor: Pick<AuthContext, 'kind' | 'actorId' | 'label'> | { kind: 'system' | 'ai_agent'; actorId?: string; label: string },
  metadata?: Prisma.InputJsonValue,
) {
  const actorType = actor.kind === 'user' ? 'user' : actor.kind === 'system' ? 'system' : actor.kind === 'api_key' ? 'system' : 'ai_agent';
  return prisma.incidentEvent.create({
    data: { incidentId, type, message, actorType, actorId: actor.actorId, actorLabel: actor.label, metadata },
  });
}

interface CreateIncidentInput extends z.infer<typeof createBody> {
  source?: string;
}

/** Shared by the HTTP route and by alert-triggered incident creation. */
export async function createIncident(
  organizationId: string,
  input: CreateIncidentInput,
  actor: { kind: 'user' | 'system' | 'api_key'; actorId?: string; label: string },
) {
  await Promise.all([assertServices(organizationId, input.serviceIds), assertMembers(organizationId, [input.assigneeId, input.commanderId])]);
  const { serviceIds, source, ...rest } = input;
  const incident = await prisma.$transaction(async (tx) => {
    // Per-organisation incident numbers, allocated atomically.
    const org = await tx.organization.update({ where: { id: organizationId }, data: { incidentCounter: { increment: 1 } } });
    return tx.incident.create({
      data: {
        ...rest,
        organizationId,
        number: org.incidentCounter,
        source: source ?? 'manual',
        createdById: actor.kind === 'user' ? actor.actorId : null,
        services: { create: [...new Set(serviceIds)].map((serviceId) => ({ serviceId })) },
        events: {
          create: {
            type: 'created',
            message: `Incident opened as ${input.severity}`,
            actorType: actor.kind === 'user' ? 'user' : 'system',
            actorId: actor.actorId,
            actorLabel: actor.label,
          },
        },
      },
      include: listInclude,
    });
  });
  await notifyUsers([incident.assigneeId, incident.commanderId].filter((id) => id !== actor.actorId), {
    organizationId,
    type: 'incident.assigned',
    title: `${incidentKey(incident.number)} assigned to you`,
    body: incident.title,
    link: `/incidents/${incident.id}`,
  });
  return incident;
}

export const incidentsRouter = Router();

incidentsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = listQuery.parse(req.query);
  const number = q.q ? /^(?:INC-)?(\d+)$/i.exec(q.q)?.[1] : undefined;
  const where: Prisma.IncidentWhereInput = {
    organizationId,
    ...(q.q
      ? {
          OR: [
            { title: { contains: q.q, mode: 'insensitive' } },
            { description: { contains: q.q, mode: 'insensitive' } },
            ...(number ? [{ number: Number(number) }] : []),
          ],
        }
      : {}),
    ...(q.status ? { status: { in: q.status as IncidentStatus[] } } : q.active === 'true' ? { status: { in: ACTIVE } } : q.active === 'false' ? { status: { notIn: ACTIVE } } : {}),
    ...(q.severity ? { severity: { in: q.severity as never } } : {}),
    ...(q.service ? { services: { some: { service: { OR: [{ id: q.service }, { slug: q.service }] } } } } : {}),
    ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
    ...(q.from || q.to ? { startedAt: { gte: q.from, lte: q.to } } : {}),
  };
  const orderBy: Prisma.IncidentOrderByWithRelationInput[] =
    q.sort === 'severity' ? [{ severity: 'asc' }, { startedAt: 'desc' }] : [{ [q.sort]: 'desc' }];
  const [rows, total, counts] = await Promise.all([
    prisma.incident.findMany({ where, orderBy, ...paginate(q), include: listInclude }),
    prisma.incident.count({ where }),
    prisma.incident.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
  ]);
  const names = await userNames(rows.flatMap((r) => [r.assigneeId, r.commanderId, r.createdById]));
  res.json({
    ...paged(rows.map((r) => present(r, names)), total, q),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
  });
});

incidentsRouter.post('/', requirePermission('incident:write'), async (req, res) => {
  const auth = authOf(req);
  const body = createBody.parse(req.body);
  const incident = await createIncident(auth.organizationId, body, { kind: auth.kind === 'user' ? 'user' : 'api_key', actorId: auth.actorId, label: auth.label });
  await audit(req, 'incident.create', 'incident', incident.id, { key: incidentKey(incident.number), severity: incident.severity });
  const names = await userNames([incident.assigneeId, incident.commanderId, incident.createdById]);
  res.status(201).json(present(incident, names));
});

incidentsRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const incident = await requireIncident(organizationId, param(req.params.id));
  const [events, investigations, remediations, alerts, postmortem] = await Promise.all([
    prisma.incidentEvent.findMany({ where: { incidentId: incident.id }, orderBy: { createdAt: 'asc' } }),
    prisma.investigation.findMany({
      where: { incidentId: incident.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, question: true, status: true, summary: true, confidence: true, provider: true, model: true, createdAt: true, completedAt: true },
    }),
    prisma.remediationAction.findMany({
      where: { incidentId: incident.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, type: true, risk: true, status: true, proposedByType: true, createdAt: true },
    }),
    prisma.alert.findMany({ where: { incidentId: incident.id }, include: { rule: { select: { name: true, metric: true } }, service: { select: { name: true } } } }),
    prisma.knowledgeDocument.findUnique({ where: { incidentId: incident.id }, select: { id: true, title: true, updatedAt: true } }),
  ]);
  const names = await userNames([incident.assigneeId, incident.commanderId, incident.createdById]);
  res.json({ ...present(incident, names), timeline: events, investigations, remediations, alerts, postmortem });
});

incidentsRouter.patch('/:id', requirePermission('incident:write'), async (req, res) => {
  const auth = authOf(req);
  const { organizationId } = auth;
  const existing = await requireIncident(organizationId, param(req.params.id));
  const body = updateBody.parse(req.body);
  await assertMembers(organizationId, [body.assigneeId, body.commanderId]);
  if (body.serviceIds) await assertServices(organizationId, body.serviceIds);

  const { serviceIds, note, ...fields } = body;
  const data: Prisma.IncidentUpdateInput = { ...fields };
  const events: { type: string; message: string; metadata?: Prisma.InputJsonValue }[] = [];
  const now = new Date();

  if (body.status && body.status !== existing.status) {
    if (body.status === 'CLOSED' && existing.status !== 'RESOLVED') throw badRequest('Only resolved incidents can be closed');
    const reopening = !ACTIVE.includes(existing.status) && ACTIVE.includes(body.status);
    if (reopening) Object.assign(data, { resolvedAt: null, closedAt: null });
    if (body.status !== 'OPEN' && !existing.acknowledgedAt) data.acknowledgedAt = now;
    if (body.status === 'MITIGATED' && !existing.mitigatedAt) data.mitigatedAt = now;
    if (body.status === 'RESOLVED') {
      data.resolvedAt = now;
      if (!existing.mitigatedAt) data.mitigatedAt = now;
    }
    if (body.status === 'CLOSED') data.closedAt = now;
    events.push({
      type: 'status_change',
      message: `Status changed from ${existing.status} to ${body.status}${note ? ` — ${note}` : ''}`,
      metadata: { from: existing.status, to: body.status },
    });
  }
  if (body.severity && body.severity !== existing.severity) {
    events.push({ type: 'severity_change', message: `Severity changed from ${existing.severity} to ${body.severity}`, metadata: { from: existing.severity, to: body.severity } });
  }
  const names = await userNames([body.assigneeId ?? null, body.commanderId ?? null]);
  if (body.assigneeId !== undefined && body.assigneeId !== existing.assigneeId) {
    events.push({ type: 'assignment', message: body.assigneeId ? `Assigned to ${names.get(body.assigneeId) ?? 'a team member'}` : 'Assignee removed' });
  }
  if (body.commanderId !== undefined && body.commanderId !== existing.commanderId) {
    events.push({ type: 'assignment', message: body.commanderId ? `${names.get(body.commanderId) ?? 'A team member'} is now incident commander` : 'Incident commander removed' });
  }
  if (body.rootCause !== undefined && body.rootCause !== existing.rootCause && body.rootCause) {
    events.push({ type: 'update', message: 'Root cause recorded' });
  }
  if (body.resolution !== undefined && body.resolution !== existing.resolution && body.resolution) {
    events.push({ type: 'update', message: 'Resolution recorded' });
  }
  if (serviceIds) events.push({ type: 'update', message: 'Affected services updated' });

  const actorType = auth.kind === 'user' ? 'user' : 'system';
  const updated = await prisma.$transaction(async (tx) => {
    if (serviceIds) {
      await tx.incidentService.deleteMany({ where: { incidentId: existing.id } });
      await tx.incidentService.createMany({ data: [...new Set(serviceIds)].map((serviceId) => ({ incidentId: existing.id, serviceId })) });
    }
    if (events.length) {
      await tx.incidentEvent.createMany({
        data: events.map((e) => ({ ...e, incidentId: existing.id, actorType, actorId: auth.actorId, actorLabel: auth.label })),
      });
    }
    return tx.incident.update({ where: { id: existing.id }, data, include: listInclude });
  });

  await audit(req, 'incident.update', 'incident', existing.id, { key: incidentKey(existing.number), changes: Object.keys(body) });
  const notifyIds = [
    body.assigneeId && body.assigneeId !== existing.assigneeId ? body.assigneeId : null,
    body.commanderId && body.commanderId !== existing.commanderId ? body.commanderId : null,
  ].filter((id) => id !== auth.actorId);
  await notifyUsers(notifyIds, {
    organizationId,
    type: 'incident.assigned',
    title: `${incidentKey(existing.number)} assigned to you`,
    body: updated.title,
    link: `/incidents/${existing.id}`,
  });
  const allNames = await userNames([updated.assigneeId, updated.commanderId, updated.createdById]);
  res.json(present(updated, allNames));
});

incidentsRouter.post('/:id/comments', requirePermission('incident:write'), async (req, res) => {
  const auth = authOf(req);
  const incident = await requireIncident(auth.organizationId, param(req.params.id));
  const { message } = z.object({ message: z.string().trim().min(1).max(5000) }).parse(req.body);
  const event = await addIncidentEvent(incident.id, 'comment', message, auth);
  // @mentions: "@Full Name" matched against organisation members.
  const members = await prisma.membership.findMany({ where: { organizationId: auth.organizationId }, select: { user: { select: { id: true, name: true } } } });
  const lower = message.toLowerCase();
  const mentioned = members.filter((m) => lower.includes(`@${m.user.name.toLowerCase()}`)).map((m) => m.user.id);
  const recipients = [...new Set([...mentioned, incident.assigneeId, incident.commanderId])].filter((id) => id && id !== auth.actorId);
  await notifyUsers(recipients, {
    organizationId: auth.organizationId,
    type: 'incident.comment',
    title: `${auth.label} commented on ${incidentKey(incident.number)}`,
    body: message.slice(0, 200),
    link: `/incidents/${incident.id}`,
  });
  await prisma.incident.update({ where: { id: incident.id }, data: { updatedAt: new Date() } });
  res.status(201).json(event);
});

/**
 * Everything around an incident that an investigator needs: recent changes to the affected
 * services and their upstream dependencies, error patterns, alerts and similar past incidents.
 */
export async function incidentContext(organizationId: string, incidentId: string) {
  const incident = await requireIncident(organizationId, incidentId);
  const serviceIds = incident.services.map((s) => s.service.id);
  const upstream = await prisma.serviceDependency.findMany({
    where: { serviceId: { in: serviceIds } },
    select: { serviceId: true, kind: true, dependsOn: { select: { id: true, name: true, slug: true, health: true } } },
  });
  const scope = [...new Set([...serviceIds, ...upstream.map((u) => u.dependsOn.id)])];
  const from = new Date(incident.startedAt.getTime() - 24 * 3600_000);
  const to = new Date((incident.resolvedAt ?? new Date()).getTime());
  const logFrom = new Date(incident.startedAt.getTime() - 2 * 3600_000);

  const [deployments, events, alerts, errorPatterns, similar] = await Promise.all([
    prisma.deployment.findMany({
      where: { organizationId, serviceId: { in: scope }, startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'desc' },
      take: 30,
      include: { service: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.serviceEvent.findMany({
      where: { organizationId, serviceId: { in: scope }, occurredAt: { gte: from, lte: to } },
      orderBy: { occurredAt: 'desc' },
      take: 30,
      include: { service: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.alert.findMany({
      where: { organizationId, serviceId: { in: scope }, startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: { rule: { select: { name: true, metric: true, threshold: true } }, service: { select: { name: true, slug: true } } },
    }),
    scope.length
      ? prisma.$queryRaw<{ fingerprint: string; sample: string; level: string; serviceId: string | null; count: bigint; firstSeen: Date; lastSeen: Date }[]>`
          SELECT "fingerprint", min("message") AS sample, max("level"::text) AS level, "serviceId",
                 count(*) AS count, min("timestamp") AS "firstSeen", max("timestamp") AS "lastSeen"
          FROM "LogEntry"
          WHERE "organizationId" = ${organizationId} AND "serviceId" = ANY(${scope})
            AND "level" IN ('ERROR', 'FATAL') AND "timestamp" BETWEEN ${logFrom} AND ${to}
          GROUP BY "fingerprint", "serviceId" ORDER BY count DESC LIMIT 15`
      : [],
    prisma.$queryRaw<{ id: string; number: number; title: string; severity: string; status: string; rootCause: string | null; resolution: string | null; startedAt: Date; score: number }[]>`
      SELECT i."id", i."number", i."title", i."severity"::text, i."status"::text, i."rootCause", i."resolution", i."startedAt",
             similarity(i."title", ${incident.title}) AS score
      FROM "Incident" i
      WHERE i."organizationId" = ${organizationId} AND i."id" <> ${incident.id}
        AND (similarity(i."title", ${incident.title}) > 0.15
             OR EXISTS (SELECT 1 FROM "IncidentService" s WHERE s."incidentId" = i."id" AND s."serviceId" = ANY(${serviceIds})))
      ORDER BY score DESC, i."startedAt" DESC LIMIT 6`,
  ]);
  const serviceNames = new Map((await prisma.service.findMany({ where: { id: { in: scope } }, select: { id: true, name: true, slug: true } })).map((s) => [s.id, s]));
  return {
    incident: { id: incident.id, key: incidentKey(incident.number), title: incident.title, severity: incident.severity, status: incident.status, startedAt: incident.startedAt, resolvedAt: incident.resolvedAt },
    window: { from, to },
    affectedServices: incident.services.map((s) => s.service),
    upstreamDependencies: upstream.map((u) => ({ ...u.dependsOn, kind: u.kind, requiredBy: u.serviceId })),
    deployments,
    serviceEvents: events,
    alerts,
    errorPatterns: errorPatterns.map((p) => ({ ...p, count: Number(p.count), serviceName: p.serviceId ? (serviceNames.get(p.serviceId)?.name ?? null) : null, serviceSlug: p.serviceId ? (serviceNames.get(p.serviceId)?.slug ?? null) : null })),
    similarIncidents: similar.map((s) => ({ ...s, key: incidentKey(s.number) })),
  };
}

incidentsRouter.get('/:id/context', requirePermission('read'), async (req, res) => {
  res.json(await incidentContext(authOf(req).organizationId, param(req.params.id)));
});
