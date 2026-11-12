import type { LogLevel } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { assertRange, csv, param, timeParam } from '../lib/http';
import { parseLevel } from '../lib/logParsing';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission } from '../middleware/auth';
import { incidentContext, incidentKey } from './incidents';
import { searchKnowledge } from './knowledge';
import { type LogFilter, logAnomalies, logHistogram, logPatterns, resolveServiceIds, searchLogs } from './logs';
import { KNOWN_METRICS, metricSummary } from './monitoring';
import { findService, requireService } from './services';

/**
 * Read-only tool API used by the AI investigation agent and by the MCP server.
 * Every response is compact (bounded rows, trimmed fields) so it fits in a model context,
 * and every item carries the id of the underlying record so evidence can be traced back.
 * All routes are scoped to the caller's organisation by the token.
 */
export const toolsRouter = Router();
toolsRouter.use(requirePermission('read'));

// Record which tools the agent used, for the audit trail.
toolsRouter.use((req, _res, next) => {
  if (req.auth?.kind === 'tool_token') {
    void audit(req, 'ai_tool.call', 'investigation', req.auth.investigationId, { tool: req.path, query: req.query as Record<string, string> });
  }
  next();
});

const windowQuery = z.object({ from: timeParam.default('6h'), to: timeParam.optional() });
const clip = (text: string | null | undefined, max = 400) => (text && text.length > max ? `${text.slice(0, max)}…` : (text ?? null));

function windowOf(q: { from: Date; to?: Date }) {
  const to = q.to ?? new Date();
  assertRange(q.from, to);
  return { from: q.from, to };
}

toolsRouter.get('/services', async (req, res) => {
  const { organizationId } = authOf(req);
  const services = await prisma.service.findMany({
    where: { organizationId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      tier: true,
      health: true,
      healthNote: true,
      ownerTeam: { select: { name: true } },
      dependencies: { select: { kind: true, dependsOn: { select: { slug: true } } } },
    },
  });
  res.json({
    services: services.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: clip(s.description, 200),
      tier: s.tier,
      health: s.health,
      healthNote: s.healthNote,
      ownerTeam: s.ownerTeam?.name ?? null,
      dependsOn: s.dependencies.map((d) => ({ slug: d.dependsOn.slug, kind: d.kind })),
    })),
  });
});

toolsRouter.get('/services/:ref', async (req, res) => {
  const { organizationId } = authOf(req);
  const base = await requireService(organizationId, param(req.params.ref));
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: base.id },
    include: {
      ownerTeam: { select: { name: true } },
      dependencies: { include: { dependsOn: { select: { slug: true, name: true, health: true, healthNote: true } } } },
      dependents: { include: { service: { select: { slug: true, name: true, health: true } } } },
      repositories: { select: { fullName: true } },
      alerts: { where: { status: 'firing' }, select: { message: true, startedAt: true } },
    },
  });
  res.json({
    id: service.id,
    slug: service.slug,
    name: service.name,
    description: service.description,
    tier: service.tier,
    language: service.language,
    health: service.health,
    healthNote: service.healthNote,
    ownerTeam: service.ownerTeam?.name ?? null,
    repositories: service.repositories.map((r) => r.fullName),
    dependsOn: service.dependencies.map((d) => ({ ...d.dependsOn, kind: d.kind, description: d.description })),
    dependedOnBy: service.dependents.map((d) => ({ ...d.service, kind: d.kind })),
    firingAlerts: service.alerts,
  });
});

toolsRouter.get('/incidents', async (req, res) => {
  const { organizationId } = authOf(req);
  const q = z.object({ q: z.string().trim().optional(), service: z.string().optional(), status: csv, limit: z.coerce.number().int().min(1).max(25).default(10) }).parse(req.query);
  const service = q.service ? await findService(organizationId, q.service) : null;
  const incidents = await prisma.incident.findMany({
    where: {
      organizationId,
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { rootCause: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(q.service ? { services: { some: { serviceId: service?.id ?? '__none__' } } } : {}),
      ...(q.status ? { status: { in: q.status as never } } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: q.limit,
    include: { services: { select: { service: { select: { slug: true } } } } },
  });
  res.json({
    incidents: incidents.map((i) => ({
      id: i.id,
      key: incidentKey(i.number),
      title: i.title,
      severity: i.severity,
      status: i.status,
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      services: i.services.map((s) => s.service.slug),
      description: clip(i.description),
      rootCause: clip(i.rootCause, 600),
      resolution: clip(i.resolution, 600),
    })),
  });
});

toolsRouter.get('/incidents/:id/context', async (req, res) => {
  const ctx = await incidentContext(authOf(req).organizationId, param(req.params.id));
  res.json({
    ...ctx,
    deployments: ctx.deployments.map((d) => ({ id: d.id, service: d.service.slug, version: d.version, status: d.status, environment: d.environment, commitSha: d.commitSha, startedAt: d.startedAt, deployedBy: d.deployedBy, isRollback: d.isRollback, description: clip(d.description, 200) })),
    serviceEvents: ctx.serviceEvents.map((e) => ({ id: e.id, service: e.service.slug, type: e.type, title: e.title, details: clip(e.details, 300), occurredAt: e.occurredAt, actor: e.actor })),
    alerts: ctx.alerts.map((a) => ({ id: a.id, service: a.service.slug, message: a.message, status: a.status, startedAt: a.startedAt, resolvedAt: a.resolvedAt })),
    errorPatterns: ctx.errorPatterns.map((p) => ({ ...p, sample: clip(p.sample, 300) })),
    similarIncidents: ctx.similarIncidents.map((s) => ({ ...s, rootCause: clip(s.rootCause, 400), resolution: clip(s.resolution, 400) })),
  });
});

const logQuery = windowQuery.extend({
  service: csv,
  level: csv.transform((v) => v?.map((l) => parseLevel(l) as LogLevel)),
  q: z.string().trim().max(200).optional(),
  traceId: z.string().optional(),
  fingerprint: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

async function logFilter(organizationId: string, q: z.infer<typeof logQuery>): Promise<LogFilter> {
  return { organizationId, ...windowOf(q), serviceIds: await resolveServiceIds(organizationId, q.service), levels: q.level, q: q.q || undefined, traceId: q.traceId, fingerprint: q.fingerprint };
}

toolsRouter.get('/logs/search', async (req, res) => {
  const q = logQuery.parse(req.query);
  const filter = await logFilter(authOf(req).organizationId, q);
  const { rows, total } = await searchLogs(filter, { page: 1, pageSize: q.limit });
  res.json({
    window: { from: filter.from, to: filter.to },
    totalMatching: total,
    returned: rows.length,
    logs: rows.map((l) => ({ id: l.id, timestamp: l.timestamp, level: l.level, service: l.service?.slug ?? null, message: clip(l.message, 500), traceId: l.traceId, fingerprint: l.fingerprint, attributes: l.attributes })),
  });
});

toolsRouter.get('/logs/patterns', async (req, res) => {
  const q = logQuery.parse(req.query);
  const filter = await logFilter(authOf(req).organizationId, q);
  const patterns = await logPatterns({ ...filter, levels: filter.levels ?? ['WARN', 'ERROR', 'FATAL'] }, Math.min(q.limit, 30));
  res.json({ window: { from: filter.from, to: filter.to }, patterns: patterns.map((p) => ({ ...p, sample: clip(p.sample, 300) })) });
});

toolsRouter.get('/logs/anomalies', async (req, res) => {
  const q = logQuery.parse(req.query);
  const filter = await logFilter(authOf(req).organizationId, q);
  const anomalies = await logAnomalies(filter);
  res.json({
    window: { from: filter.from, to: filter.to },
    method: 'Error/warn patterns in the window compared with the preceding 6x baseline window (rate-normalised).',
    anomalies: anomalies.map((p) => ({ ...p, sample: clip(p.sample, 300) })),
  });
});

toolsRouter.get('/logs/histogram', async (req, res) => {
  const q = logQuery.parse(req.query);
  const filter = await logFilter(authOf(req).organizationId, q);
  const h = await logHistogram(filter, 30);
  res.json({ window: { from: filter.from, to: filter.to }, bucketSeconds: h.bucketSeconds, buckets: h.buckets.map((b) => ({ timestamp: b.timestamp, errors: Number(b.ERROR) + Number(b.FATAL), warnings: b.WARN, total: b.total })) });
});

const changeQuery = windowQuery.extend({ from: timeParam.default('24h'), service: csv, limit: z.coerce.number().int().min(1).max(50).default(20) });

toolsRouter.get('/deployments', async (req, res) => {
  const { organizationId } = authOf(req);
  const q = changeQuery.parse(req.query);
  const window = windowOf(q);
  const serviceIds = await resolveServiceIds(organizationId, q.service);
  const deployments = await prisma.deployment.findMany({
    where: { organizationId, ...(serviceIds ? { serviceId: { in: serviceIds } } : {}), startedAt: { gte: window.from, lte: window.to } },
    orderBy: { startedAt: 'desc' },
    take: q.limit,
    include: { service: { select: { slug: true } } },
  });
  res.json({
    window,
    deployments: deployments.map((d) => ({ id: d.id, service: d.service.slug, version: d.version, environment: d.environment, status: d.status, commitSha: d.commitSha, branch: d.branch, deployedBy: d.deployedBy, startedAt: d.startedAt, finishedAt: d.finishedAt, isRollback: d.isRollback, description: clip(d.description, 300) })),
  });
});

/** Commits and pull requests for the repositories linked to the given services. */
toolsRouter.get('/code-changes', async (req, res) => {
  const { organizationId } = authOf(req);
  const q = changeQuery.extend({ commitSha: z.string().min(7).optional() }).parse(req.query);
  const window = windowOf(q);
  const serviceIds = await resolveServiceIds(organizationId, q.service);
  const repoWhere = { organizationId, ...(serviceIds ? { serviceId: { in: serviceIds } } : {}) };
  const [commits, pulls] = await Promise.all([
    prisma.commit.findMany({
      where: q.commitSha ? { repository: { organizationId }, sha: { startsWith: q.commitSha } } : { repository: repoWhere, committedAt: { gte: window.from, lte: window.to } },
      orderBy: { committedAt: 'desc' },
      take: q.limit,
      include: { repository: { select: { fullName: true, isMock: true, service: { select: { slug: true } } } } },
    }),
    prisma.pullRequest.findMany({
      where: q.commitSha ? { repository: { organizationId }, mergeCommitSha: { startsWith: q.commitSha } } : { repository: repoWhere, mergedAt: { gte: window.from, lte: window.to } },
      orderBy: { mergedAt: 'desc' },
      take: q.limit,
      include: { repository: { select: { fullName: true, isMock: true, service: { select: { slug: true } } } } },
    }),
  ]);
  res.json({
    window,
    commits: commits.map((c) => ({ id: c.id, sha: c.sha.slice(0, 12), repository: c.repository.fullName, service: c.repository.service?.slug ?? null, sampleData: c.repository.isMock, message: clip(c.message, 400), author: c.authorLogin ?? c.authorName, committedAt: c.committedAt, additions: c.additions, deletions: c.deletions, files: Array.isArray(c.filesChanged) ? (c.filesChanged as { filename: string }[]).slice(0, 15).map((f) => f.filename) : [] })),
    pullRequests: pulls.map((p) => ({ id: p.id, number: p.number, repository: p.repository.fullName, service: p.repository.service?.slug ?? null, sampleData: p.repository.isMock, title: p.title, body: clip(p.body, 500), author: p.authorLogin, state: p.state, mergedAt: p.mergedAt, mergeCommitSha: p.mergeCommitSha?.slice(0, 12) ?? null, labels: p.labels })),
  });
});

toolsRouter.get('/service-events', async (req, res) => {
  const { organizationId } = authOf(req);
  const q = changeQuery.parse(req.query);
  const window = windowOf(q);
  const serviceIds = await resolveServiceIds(organizationId, q.service);
  const events = await prisma.serviceEvent.findMany({
    where: { organizationId, ...(serviceIds ? { serviceId: { in: serviceIds } } : {}), occurredAt: { gte: window.from, lte: window.to } },
    orderBy: { occurredAt: 'desc' },
    take: q.limit,
    include: { service: { select: { slug: true } } },
  });
  res.json({ window, events: events.map((e) => ({ id: e.id, service: e.service.slug, type: e.type, title: e.title, details: clip(e.details, 400), actor: e.actor, source: e.source, occurredAt: e.occurredAt })) });
});

toolsRouter.get('/metrics', async (req, res) => {
  const { organizationId } = authOf(req);
  const q = windowQuery.extend({ service: z.string(), metric: csv }).parse(req.query);
  const window = windowOf(q);
  const service = await requireService(organizationId, q.service);
  const available = await prisma.metricSample.findMany({ where: { organizationId, serviceId: service.id, timestamp: { gte: new Date(window.from.getTime() - 86_400_000) } }, distinct: ['metric'], select: { metric: true } });
  const metrics = (q.metric ?? available.map((a) => a.metric)).slice(0, 8);
  const summaries = await Promise.all(metrics.map((m) => metricSummary(organizationId, service.id, m, window.from, window.to)));
  res.json({
    service: service.slug,
    window,
    note: 'changePercent compares the window average with the equally long window immediately before it.',
    metrics: summaries.map((s) => ({ ...s, label: KNOWN_METRICS[s.metric]?.label ?? s.metric })),
  });
});

toolsRouter.post('/knowledge/search', async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z.object({ query: z.string().trim().min(2).max(500), limit: z.number().int().min(1).max(10).default(5), service: z.string().optional() }).parse(req.body);
  const service = body.service ? await findService(organizationId, body.service) : null;
  const result = await searchKnowledge(organizationId, body.query, { limit: body.limit, serviceId: service?.id });
  res.json({
    mode: result.mode,
    note: result.note,
    results: result.hits.map((h) => ({ chunkId: h.chunkId, documentId: h.documentId, title: h.title, type: h.type, section: h.heading, content: clip(h.content, 1400), similarity: h.similarity, matchedBy: h.matchedBy })),
  });
});
