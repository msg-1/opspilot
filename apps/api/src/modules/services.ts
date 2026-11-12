import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { csv, paged, paginate, paginationQuery, param, timeParam } from '../lib/http';
import { prisma } from '../lib/prisma';
import { slugify } from '../lib/slug';
import { authOf, requirePermission } from '../middleware/auth';

/** Resolves a service by id or slug inside the caller's organisation. */
export async function findService(organizationId: string, idOrSlug: string) {
  return prisma.service.findFirst({ where: { organizationId, OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
}

export async function requireService(organizationId: string, idOrSlug: string) {
  const service = await findService(organizationId, idOrSlug);
  if (!service) throw notFound('Service');
  return service;
}

// ───────────────────────── Services ─────────────────────────

export const servicesRouter = Router();

const serviceBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).nullable().optional(),
  tier: z.enum(['TIER1', 'TIER2', 'TIER3']).optional(),
  lifecycle: z.enum(['EXPERIMENTAL', 'PRODUCTION', 'DEPRECATED']).optional(),
  language: z.string().trim().max(40).nullable().optional(),
  repoUrl: z.string().url().max(300).nullable().optional(),
  runbookUrl: z.string().url().max(300).nullable().optional(),
  ownerTeamId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const listQuery = paginationQuery.extend({
  q: z.string().trim().optional(),
  tier: csv,
  health: csv,
  teamId: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
});

async function assertTeam(organizationId: string, teamId?: string | null) {
  if (!teamId) return;
  if (!(await prisma.team.findFirst({ where: { id: teamId, organizationId } }))) throw badRequest('Owner team does not exist');
}

servicesRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = listQuery.parse(req.query);
  const where: Prisma.ServiceWhereInput = {
    organizationId,
    ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { tags: { has: q.q.toLowerCase() } }] } : {}),
    ...(q.tier ? { tier: { in: q.tier as never } } : {}),
    ...(q.health ? { health: { in: q.health as never } } : {}),
    ...(q.teamId ? { ownerTeamId: q.teamId } : {}),
  };
  const [services, total] = await Promise.all([
    prisma.service.findMany({
      where,
      orderBy: [{ tier: 'asc' }, { name: 'asc' }],
      ...paginate(q),
      include: {
        ownerTeam: { select: { id: true, name: true } },
        _count: { select: { dependencies: true, dependents: true } },
        deployments: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, version: true, status: true, startedAt: true, environment: true } },
      },
    }),
    prisma.service.count({ where }),
  ]);
  const openIncidents = await prisma.incidentService.groupBy({
    by: ['serviceId'],
    where: { serviceId: { in: services.map((s) => s.id) }, incident: { status: { notIn: ['RESOLVED', 'CLOSED'] } } },
    _count: true,
  });
  const openByService = new Map(openIncidents.map((o) => [o.serviceId, o._count]));
  res.json(
    paged(
      services.map(({ deployments, _count, ...s }) => ({
        ...s,
        lastDeployment: deployments[0] ?? null,
        dependencyCount: _count.dependencies,
        dependentCount: _count.dependents,
        openIncidents: openByService.get(s.id) ?? 0,
      })),
      total,
      q,
    ),
  );
});

/** Whole dependency graph: nodes + edges, used by the service map. */
servicesRouter.get('/graph', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const [nodes, edges] = await Promise.all([
    prisma.service.findMany({ where: { organizationId }, select: { id: true, name: true, slug: true, tier: true, health: true }, orderBy: { name: 'asc' } }),
    prisma.serviceDependency.findMany({ where: { service: { organizationId } }, select: { serviceId: true, dependsOnId: true, kind: true } }),
  ]);
  res.json({ nodes, edges: edges.map((e) => ({ from: e.serviceId, to: e.dependsOnId, kind: e.kind })) });
});

servicesRouter.post('/', requirePermission('service:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = serviceBody.parse(req.body);
  await assertTeam(organizationId, body.ownerTeamId);
  const service = await prisma.service.create({
    data: { ...body, tags: body.tags?.map((t) => t.toLowerCase()) ?? [], organizationId, slug: slugify(body.name) },
  });
  await audit(req, 'service.create', 'service', service.id, { name: service.name });
  res.status(201).json(service);
});

servicesRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const base = await requireService(organizationId, param(req.params.id));
  const since = new Date(Date.now() - 24 * 3600_000);
  const [service, deployments, incidents, events, errorCount, alerts] = await Promise.all([
    prisma.service.findUniqueOrThrow({
      where: { id: base.id },
      include: {
        ownerTeam: { select: { id: true, name: true, members: { where: { onCall: true }, select: { user: { select: { id: true, name: true } } } } } },
        dependencies: { include: { dependsOn: { select: { id: true, name: true, slug: true, health: true, tier: true } } } },
        dependents: { include: { service: { select: { id: true, name: true, slug: true, health: true, tier: true } } } },
        repositories: { select: { id: true, fullName: true, url: true, isMock: true } },
        alertRules: true,
      },
    }),
    prisma.deployment.findMany({ where: { serviceId: base.id }, orderBy: { startedAt: 'desc' }, take: 10 }),
    prisma.incident.findMany({
      where: { organizationId, services: { some: { serviceId: base.id } } },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { id: true, number: true, title: true, severity: true, status: true, startedAt: true, resolvedAt: true },
    }),
    prisma.serviceEvent.findMany({ where: { serviceId: base.id }, orderBy: { occurredAt: 'desc' }, take: 10 }),
    prisma.logEntry.count({ where: { organizationId, serviceId: base.id, level: { in: ['ERROR', 'FATAL'] }, timestamp: { gte: since } } }),
    prisma.alert.findMany({ where: { serviceId: base.id, status: 'firing' }, orderBy: { startedAt: 'desc' }, include: { rule: { select: { name: true, metric: true, threshold: true } } } }),
  ]);
  res.json({
    ...service,
    dependencies: service.dependencies.map((d) => ({ ...d.dependsOn, kind: d.kind, description: d.description })),
    dependents: service.dependents.map((d) => ({ ...d.service, kind: d.kind })),
    onCall: service.ownerTeam?.members.map((m) => m.user) ?? [],
    ownerTeam: service.ownerTeam ? { id: service.ownerTeam.id, name: service.ownerTeam.name } : null,
    recentDeployments: deployments,
    recentIncidents: incidents,
    recentEvents: events,
    firingAlerts: alerts,
    errorsLast24h: errorCount,
  });
});

servicesRouter.patch('/:id', requirePermission('service:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const existing = await requireService(organizationId, param(req.params.id));
  const body = serviceBody.partial().parse(req.body);
  await assertTeam(organizationId, body.ownerTeamId);
  const service = await prisma.service.update({
    where: { id: existing.id },
    data: { ...body, ...(body.tags ? { tags: body.tags.map((t) => t.toLowerCase()) } : {}), ...(body.name ? { slug: slugify(body.name) } : {}) },
  });
  await audit(req, 'service.update', 'service', service.id, body);
  res.json(service);
});

servicesRouter.delete('/:id', requirePermission('service:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const existing = await requireService(organizationId, param(req.params.id));
  await prisma.service.delete({ where: { id: existing.id } });
  await audit(req, 'service.delete', 'service', existing.id, { name: existing.name });
  res.status(204).end();
});

/** Replaces the full set of upstream dependencies for a service. */
servicesRouter.put('/:id/dependencies', requirePermission('service:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const service = await requireService(organizationId, param(req.params.id));
  const body = z
    .object({
      dependencies: z
        .array(z.object({ serviceId: z.string(), kind: z.enum(['sync', 'async', 'datastore']).default('sync'), description: z.string().max(300).optional() }))
        .max(100),
    })
    .parse(req.body);
  const ids = [...new Set(body.dependencies.map((d) => d.serviceId))];
  if (ids.includes(service.id)) throw badRequest('A service cannot depend on itself');
  const found = await prisma.service.count({ where: { organizationId, id: { in: ids } } });
  if (found !== ids.length) throw badRequest('One or more dependencies do not exist');
  await prisma.$transaction([
    prisma.serviceDependency.deleteMany({ where: { serviceId: service.id } }),
    prisma.serviceDependency.createMany({
      data: ids.map((id) => {
        const dep = body.dependencies.find((d) => d.serviceId === id)!;
        return { serviceId: service.id, dependsOnId: id, kind: dep.kind, description: dep.description };
      }),
    }),
  ]);
  await audit(req, 'service.dependencies_set', 'service', service.id, { dependsOn: ids });
  res.json({ serviceId: service.id, dependencies: ids });
});

// ───────────────────────── Deployments ─────────────────────────

export const deploymentsRouter = Router();

const deploymentStatus = z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK']);

export const deploymentBody = z.object({
  service: z.string().min(1).describe('Service id or slug'),
  version: z.string().trim().min(1).max(80),
  environment: z.string().trim().min(1).max(40).default('production'),
  status: deploymentStatus.default('SUCCEEDED'),
  commitSha: z.string().trim().min(7).max(64).nullable().optional(),
  branch: z.string().trim().max(120).nullable().optional(),
  deployedBy: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().nullable().optional(),
});

export async function recordDeployment(organizationId: string, input: z.infer<typeof deploymentBody>, source: string) {
  const service = await requireService(organizationId, input.service);
  const { service: _s, ...rest } = input;
  const startedAt = input.startedAt ?? new Date();
  return prisma.deployment.create({
    data: {
      ...rest,
      startedAt,
      finishedAt: input.finishedAt ?? (['SUCCEEDED', 'FAILED', 'ROLLED_BACK'].includes(input.status) ? startedAt : null),
      organizationId,
      serviceId: service.id,
      source,
    },
    include: { service: { select: { id: true, name: true, slug: true } } },
  });
}

const deploymentQuery = paginationQuery.extend({
  service: z.string().optional(),
  environment: z.string().optional(),
  status: csv,
  from: timeParam.optional(),
  to: timeParam.optional(),
});

deploymentsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = deploymentQuery.parse(req.query);
  const service = q.service ? await requireService(organizationId, q.service) : null;
  const where: Prisma.DeploymentWhereInput = {
    organizationId,
    ...(service ? { serviceId: service.id } : {}),
    ...(q.environment ? { environment: q.environment } : {}),
    ...(q.status ? { status: { in: q.status as never } } : {}),
    ...(q.from || q.to ? { startedAt: { gte: q.from, lte: q.to } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.deployment.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      ...paginate(q),
      include: { service: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.deployment.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

deploymentsRouter.post('/', requirePermission('deployment:write'), async (req, res) => {
  const auth = authOf(req);
  const body = deploymentBody.parse(req.body);
  const deployment = await recordDeployment(
    auth.organizationId,
    { ...body, deployedBy: body.deployedBy ?? (auth.kind === 'user' ? auth.label : null) },
    auth.kind === 'api_key' ? 'api' : 'manual',
  );
  await audit(req, 'deployment.record', 'deployment', deployment.id, { service: deployment.service.slug, version: deployment.version, environment: deployment.environment });
  res.status(201).json(deployment);
});

deploymentsRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const deployment = await prisma.deployment.findFirst({
    where: { id: param(req.params.id), organizationId },
    include: {
      service: { select: { id: true, name: true, slug: true } },
      rollbackOf: { select: { id: true, version: true, startedAt: true } },
      rollbacks: { select: { id: true, version: true, startedAt: true, status: true } },
    },
  });
  if (!deployment) throw notFound('Deployment');
  // Code changes shipped by this deployment, and incidents that began shortly after it.
  const windowEnd = new Date(deployment.startedAt.getTime() + 6 * 3600_000);
  const [commit, pullRequests, incidentsAfter, previous] = await Promise.all([
    deployment.commitSha
      ? prisma.commit.findFirst({
          where: { sha: { startsWith: deployment.commitSha.slice(0, 7) }, repository: { organizationId } },
          include: { repository: { select: { fullName: true } } },
        })
      : null,
    deployment.commitSha
      ? prisma.pullRequest.findMany({
          where: { mergeCommitSha: { startsWith: deployment.commitSha.slice(0, 7) }, repository: { organizationId } },
          select: { id: true, number: true, title: true, authorLogin: true, url: true, mergedAt: true },
        })
      : [],
    prisma.incident.findMany({
      where: { organizationId, services: { some: { serviceId: deployment.serviceId } }, startedAt: { gte: deployment.startedAt, lte: windowEnd } },
      select: { id: true, number: true, title: true, severity: true, status: true, startedAt: true },
    }),
    prisma.deployment.findFirst({
      where: { serviceId: deployment.serviceId, environment: deployment.environment, startedAt: { lt: deployment.startedAt } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, version: true, commitSha: true, startedAt: true, status: true },
    }),
  ]);
  res.json({ ...deployment, commit, pullRequests, incidentsAfter, previousDeployment: previous });
});

deploymentsRouter.patch('/:id', requirePermission('deployment:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z.object({ status: deploymentStatus.optional(), description: z.string().max(2000).nullable().optional(), finishedAt: z.coerce.date().nullable().optional() }).parse(req.body);
  const existing = await prisma.deployment.findFirst({ where: { id: param(req.params.id), organizationId } });
  if (!existing) throw notFound('Deployment');
  const finished = body.status && ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'].includes(body.status) && !existing.finishedAt;
  const deployment = await prisma.deployment.update({
    where: { id: existing.id },
    data: { ...body, ...(finished && body.finishedAt === undefined ? { finishedAt: new Date() } : {}) },
  });
  await audit(req, 'deployment.update', 'deployment', deployment.id, body);
  res.json(deployment);
});

// ───────────────────────── Service events ─────────────────────────

export const serviceEventsRouter = Router();

export const serviceEventBody = z.object({
  service: z.string().min(1),
  type: z.enum(['config_change', 'feature_flag', 'scaling', 'restart', 'infrastructure', 'alert', 'maintenance', 'other']),
  title: z.string().trim().min(2).max(200),
  details: z.string().trim().max(4000).nullable().optional(),
  actor: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  occurredAt: z.coerce.date().optional(),
});

export async function recordServiceEvent(organizationId: string, input: z.infer<typeof serviceEventBody>, source: string) {
  const service = await requireService(organizationId, input.service);
  const { service: _s, metadata, ...rest } = input;
  return prisma.serviceEvent.create({
    data: { ...rest, metadata: metadata as Prisma.InputJsonValue | undefined, organizationId, serviceId: service.id, source },
    include: { service: { select: { id: true, name: true, slug: true } } },
  });
}

serviceEventsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = paginationQuery
    .extend({ service: z.string().optional(), type: csv, from: timeParam.optional(), to: timeParam.optional() })
    .parse(req.query);
  const service = q.service ? await requireService(organizationId, q.service) : null;
  const where: Prisma.ServiceEventWhereInput = {
    organizationId,
    ...(service ? { serviceId: service.id } : {}),
    ...(q.type ? { type: { in: q.type } } : {}),
    ...(q.from || q.to ? { occurredAt: { gte: q.from, lte: q.to } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.serviceEvent.findMany({ where, orderBy: { occurredAt: 'desc' }, ...paginate(q), include: { service: { select: { id: true, name: true, slug: true } } } }),
    prisma.serviceEvent.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

serviceEventsRouter.post('/', requirePermission('event:write'), async (req, res) => {
  const auth = authOf(req);
  const body = serviceEventBody.parse(req.body);
  const event = await recordServiceEvent(auth.organizationId, { ...body, actor: body.actor ?? auth.label }, auth.kind === 'api_key' ? 'api' : 'manual');
  await audit(req, 'service_event.record', 'service_event', event.id, { service: event.service.slug, type: event.type });
  res.status(201).json(event);
});
