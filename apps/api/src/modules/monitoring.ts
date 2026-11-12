import { type HealthStatus, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit, writeAudit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { assertRange, paged, paginate, paginationQuery, param, timeParam } from '../lib/http';
import { logger } from '../lib/logger';
import { notifyRoles } from '../lib/notify';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission } from '../middleware/auth';
import { createIncident, incidentKey } from './incidents';
import { requireService } from './services';

export const KNOWN_METRICS: Record<string, { label: string; unit: string }> = {
  error_rate: { label: 'Error rate', unit: '%' },
  latency_p95_ms: { label: 'p95 latency', unit: 'ms' },
  latency_p50_ms: { label: 'p50 latency', unit: 'ms' },
  requests_per_min: { label: 'Throughput', unit: 'req/min' },
  cpu_percent: { label: 'CPU', unit: '%' },
  memory_percent: { label: 'Memory', unit: '%' },
  db_connections: { label: 'DB connections', unit: '' },
  queue_depth: { label: 'Queue depth', unit: '' },
};

const STALE_AFTER_MS = 15 * 60_000;

// ───────────────────────── Metric ingestion & queries ─────────────────────────

export const metricsBody = z.object({
  samples: z
    .array(
      z.object({
        service: z.string().min(1).max(80),
        metric: z.string().trim().regex(/^[a-z][a-z0-9_]{1,60}$/, 'Metric names are lower_snake_case'),
        value: z.number().finite(),
        timestamp: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export async function ingestMetrics(organizationId: string, body: z.infer<typeof metricsBody>) {
  const refs = [...new Set(body.samples.map((s) => s.service))];
  const services = await prisma.service.findMany({ where: { organizationId, OR: [{ id: { in: refs } }, { slug: { in: refs } }] }, select: { id: true, slug: true } });
  const byRef = new Map<string, string>();
  for (const s of services) {
    byRef.set(s.id, s.id);
    byRef.set(s.slug, s.id);
  }
  const now = new Date();
  const unknown = new Set<string>();
  const rows = body.samples.flatMap((s) => {
    const serviceId = byRef.get(s.service);
    if (!serviceId) {
      unknown.add(s.service);
      return [];
    }
    return [{ organizationId, serviceId, metric: s.metric, value: s.value, timestamp: s.timestamp ?? now }];
  });
  const result = rows.length ? await prisma.metricSample.createMany({ data: rows }) : { count: 0 };
  return { accepted: result.count, rejected: body.samples.length - result.count, unknownServices: [...unknown] };
}

export async function metricSeries(organizationId: string, serviceId: string, metric: string, from: Date, to: Date, targetBuckets = 90) {
  const span = Math.max(60, (to.getTime() - from.getTime()) / 1000);
  const steps = [60, 300, 600, 900, 1800, 3600, 3 * 3600, 6 * 3600, 86_400];
  const bucketSeconds = steps.find((s) => span / s <= targetBuckets) ?? 86_400;
  const rows = await prisma.$queryRaw<{ bucket: Date; avg: number; max: number; min: number }[]>`
    SELECT to_timestamp(floor(extract(epoch FROM "timestamp") / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
           avg("value")::float8 AS avg, max("value")::float8 AS max, min("value")::float8 AS min
    FROM "MetricSample"
    WHERE "organizationId" = ${organizationId} AND "serviceId" = ${serviceId} AND "metric" = ${metric}
      AND "timestamp" BETWEEN ${from} AND ${to}
    GROUP BY 1 ORDER BY 1`;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { bucketSeconds, points: rows.map((r) => ({ timestamp: r.bucket, avg: round(r.avg), max: round(r.max), min: round(r.min) })) };
}

/** Summary statistics used by the AI tools: how a metric behaved in a window versus the window before it. */
export async function metricSummary(organizationId: string, serviceId: string, metric: string, from: Date, to: Date) {
  const before = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const stat = async (a: Date, b: Date) => {
    const r = await prisma.metricSample.aggregate({
      where: { organizationId, serviceId, metric, timestamp: { gte: a, lte: b } },
      _avg: { value: true },
      _max: { value: true },
      _min: { value: true },
      _count: true,
    });
    return { avg: r._avg.value, max: r._max.value, min: r._min.value, samples: r._count };
  };
  const [window, baseline] = await Promise.all([stat(from, to), stat(before, new Date(from.getTime() - 1))]);
  const changePercent = window.avg !== null && baseline.avg ? Math.round(((window.avg - baseline.avg) / baseline.avg) * 1000) / 10 : null;
  return { metric, unit: KNOWN_METRICS[metric]?.unit ?? '', window: { from, to, ...window }, baseline: { from: before, to: from, ...baseline }, changePercent };
}

// ───────────────────────── Alert evaluation & service health ─────────────────────────

/**
 * Evaluates every enabled alert rule against recent metric samples, opens/resolves alerts,
 * optionally opens an incident, and recomputes service health. Runs every minute in the worker.
 */
export async function evaluateAlerts(organizationId?: string) {
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true, ...(organizationId ? { organizationId } : {}) },
    include: { service: { select: { id: true, name: true, slug: true } }, alerts: { where: { status: 'firing' }, take: 1 } },
  });
  let fired = 0;
  let resolved = 0;
  const now = new Date();
  for (const rule of rules) {
    const since = new Date(now.getTime() - rule.windowMinutes * 60_000);
    const agg = await prisma.metricSample.aggregate({
      where: { serviceId: rule.serviceId, metric: rule.metric, timestamp: { gte: since } },
      _avg: { value: true },
      _count: true,
    });
    // No samples in the window means "unknown", not "healthy": leave existing alerts untouched.
    if (!agg._count || agg._avg.value === null) continue;
    const value = Math.round(agg._avg.value * 100) / 100;
    const breached = rule.comparator === 'lt' ? value < rule.threshold : value > rule.threshold;
    const firing = rule.alerts[0];
    const unit = KNOWN_METRICS[rule.metric]?.unit ?? '';
    if (breached && !firing) {
      const message = `${rule.name}: ${rule.metric} averaged ${value}${unit} over ${rule.windowMinutes}m (threshold ${rule.comparator === 'lt' ? '<' : '>'} ${rule.threshold}${unit})`;
      const alert = await prisma.alert.create({
        data: { organizationId: rule.organizationId, ruleId: rule.id, serviceId: rule.serviceId, value, message },
      });
      fired++;
      await prisma.serviceEvent.create({
        data: { organizationId: rule.organizationId, serviceId: rule.serviceId, type: 'alert', title: `Alert firing: ${rule.name}`, details: message, source: 'monitoring', actor: 'OpsPilot monitoring' },
      });
      await writeAudit({ organizationId: rule.organizationId, actorType: 'system', actorLabel: 'OpsPilot monitoring', action: 'alert.fire', resourceType: 'alert', resourceId: alert.id, metadata: { rule: rule.name, value } });
      if (rule.autoIncident) {
        try {
          const incident = await createIncident(
            rule.organizationId,
            { title: `${rule.service.name}: ${rule.name}`, description: message, severity: rule.severity, environment: 'production', serviceIds: [rule.serviceId], source: 'alert' },
            { kind: 'system', label: 'OpsPilot monitoring' },
          );
          await prisma.alert.update({ where: { id: alert.id }, data: { incidentId: incident.id } });
          await notifyRoles(['OWNER', 'ADMIN', 'ENGINEER'], {
            organizationId: rule.organizationId,
            type: 'incident.opened',
            title: `${incidentKey(incident.number)} opened automatically`,
            body: message,
            link: `/incidents/${incident.id}`,
          });
        } catch (err) {
          logger.error({ err, ruleId: rule.id }, 'failed to open incident from alert');
        }
      } else {
        await notifyRoles(['OWNER', 'ADMIN', 'ENGINEER'], { organizationId: rule.organizationId, type: 'alert.firing', title: `Alert firing on ${rule.service.name}`, body: message, link: '/monitoring' });
      }
    } else if (!breached && firing) {
      await prisma.alert.update({ where: { id: firing.id }, data: { status: 'resolved', resolvedAt: now } });
      resolved++;
    }
  }
  await recomputeHealth(organizationId);
  return { rulesEvaluated: rules.length, fired, resolved };
}

export async function recomputeHealth(organizationId?: string) {
  const services = await prisma.service.findMany({
    where: organizationId ? { organizationId } : {},
    select: {
      id: true,
      health: true,
      healthNote: true,
      alerts: { where: { status: 'firing' }, select: { rule: { select: { severity: true, name: true } } } },
      incidents: { where: { incident: { status: { in: ['OPEN', 'INVESTIGATING', 'IDENTIFIED'] } } }, select: { incident: { select: { severity: true, number: true } } } },
    },
  });
  if (!services.length) return;
  const fresh = await prisma.metricSample.groupBy({
    by: ['serviceId'],
    where: { serviceId: { in: services.map((s) => s.id) }, timestamp: { gte: new Date(Date.now() - STALE_AFTER_MS) } },
    _count: true,
  });
  const hasFresh = new Set(fresh.map((f) => f.serviceId));
  for (const s of services) {
    let health: HealthStatus;
    let note: string;
    const sev1Alert = s.alerts.find((a) => a.rule.severity === 'SEV1');
    const sev1Incident = s.incidents.find((i) => i.incident.severity === 'SEV1');
    if (sev1Alert || sev1Incident) {
      health = 'DOWN';
      note = sev1Alert ? `Critical alert firing: ${sev1Alert.rule.name}` : `Active SEV1 incident ${incidentKey(sev1Incident!.incident.number)}`;
    } else if (s.alerts.length || s.incidents.length) {
      health = 'DEGRADED';
      note = s.alerts.length ? `${s.alerts.length} alert${s.alerts.length > 1 ? 's' : ''} firing` : `Active incident ${incidentKey(s.incidents[0]!.incident.number)}`;
    } else if (hasFresh.has(s.id)) {
      health = 'HEALTHY';
      note = 'All alert rules within thresholds';
    } else {
      health = 'UNKNOWN';
      note = 'No telemetry received in the last 15 minutes';
    }
    if (health !== s.health || note !== s.healthNote) {
      await prisma.service.update({ where: { id: s.id }, data: { health, healthNote: note, healthAt: new Date() } });
    }
  }
}

// ───────────────────────── Routes ─────────────────────────

export const monitoringRouter = Router();

monitoringRouter.get('/overview', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const since = new Date(Date.now() - 60 * 60_000);
  const [services, latest, spark, firing] = await Promise.all([
    prisma.service.findMany({
      where: { organizationId },
      orderBy: [{ tier: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, tier: true, health: true, healthNote: true, healthAt: true, ownerTeam: { select: { name: true } } },
    }),
    prisma.$queryRaw<{ serviceId: string; metric: string; value: number; timestamp: Date }[]>`
      SELECT DISTINCT ON ("serviceId", "metric") "serviceId", "metric", "value", "timestamp"
      FROM "MetricSample" WHERE "organizationId" = ${organizationId} AND "timestamp" > now() - interval '24 hours'
      ORDER BY "serviceId", "metric", "timestamp" DESC`,
    prisma.$queryRaw<{ serviceId: string; bucket: Date; value: number }[]>`
      SELECT "serviceId", to_timestamp(floor(extract(epoch FROM "timestamp") / 300) * 300) AS bucket, avg("value")::float8 AS value
      FROM "MetricSample" WHERE "organizationId" = ${organizationId} AND "metric" = 'error_rate' AND "timestamp" >= ${since}
      GROUP BY 1, 2 ORDER BY 2`,
    prisma.alert.findMany({
      where: { organizationId, status: 'firing' },
      orderBy: { startedAt: 'desc' },
      include: { rule: { select: { name: true, metric: true, threshold: true, comparator: true, severity: true } }, service: { select: { id: true, name: true, slug: true } }, incident: { select: { id: true, number: true } } },
    }),
  ]);
  const round = (n: number) => Math.round(n * 100) / 100;
  res.json({
    metrics: KNOWN_METRICS,
    summary: Object.fromEntries((['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const).map((h) => [h, services.filter((s) => s.health === h).length])),
    services: services.map((s) => ({
      ...s,
      latest: Object.fromEntries(latest.filter((l) => l.serviceId === s.id).map((l) => [l.metric, { value: round(l.value), timestamp: l.timestamp }])),
      errorRateSparkline: spark.filter((p) => p.serviceId === s.id).map((p) => ({ timestamp: p.bucket, value: round(p.value) })),
      firingAlerts: firing.filter((a) => a.serviceId === s.id).length,
    })),
    firingAlerts: firing,
  });
});

monitoringRouter.get('/series', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = z.object({ service: z.string(), metric: z.string(), from: timeParam.prefault('6h'), to: timeParam.optional() }).parse(req.query);
  const to = q.to ?? new Date();
  assertRange(q.from, to);
  const service = await requireService(organizationId, q.service);
  const metrics = q.metric.split(',').slice(0, 8);
  const series = await Promise.all(metrics.map(async (metric) => ({ metric, ...(KNOWN_METRICS[metric] ?? { label: metric, unit: '' }), ...(await metricSeries(organizationId, service.id, metric, q.from, to)) })));
  res.json({ service: { id: service.id, name: service.name, slug: service.slug }, range: { from: q.from, to }, series });
});

monitoringRouter.post('/metrics', requirePermission('metric:write'), async (req, res) => {
  res.status(202).json(await ingestMetrics(authOf(req).organizationId, metricsBody.parse(req.body)));
});

monitoringRouter.post('/evaluate', requirePermission('monitoring:write'), async (req, res) => {
  res.json(await evaluateAlerts(authOf(req).organizationId));
});

const ruleBody = z.object({
  service: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  metric: z.string().trim().regex(/^[a-z][a-z0-9_]{1,60}$/),
  comparator: z.enum(['gt', 'lt']).default('gt'),
  threshold: z.number().finite(),
  windowMinutes: z.number().int().min(1).max(1440).default(5),
  severity: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']).default('SEV3'),
  enabled: z.boolean().default(true),
  autoIncident: z.boolean().default(false),
});

monitoringRouter.get('/alert-rules', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const rules = await prisma.alertRule.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: { service: { select: { id: true, name: true, slug: true } }, _count: { select: { alerts: { where: { status: 'firing' } } } } },
  });
  res.json({ data: rules.map(({ _count, ...r }) => ({ ...r, firing: _count.alerts > 0 })) });
});

monitoringRouter.post('/alert-rules', requirePermission('monitoring:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const { service: ref, ...body } = ruleBody.parse(req.body);
  const service = await requireService(organizationId, ref);
  const rule = await prisma.alertRule.create({ data: { ...body, organizationId, serviceId: service.id } });
  await audit(req, 'alert_rule.create', 'alert_rule', rule.id, { name: rule.name, service: service.slug });
  res.status(201).json(rule);
});

monitoringRouter.patch('/alert-rules/:id', requirePermission('monitoring:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = ruleBody.omit({ service: true }).partial().parse(req.body);
  const existing = await prisma.alertRule.findFirst({ where: { id: param(req.params.id), organizationId } });
  if (!existing) throw notFound('Alert rule');
  const rule = await prisma.alertRule.update({ where: { id: existing.id }, data: body });
  await audit(req, 'alert_rule.update', 'alert_rule', rule.id, body);
  res.json(rule);
});

monitoringRouter.delete('/alert-rules/:id', requirePermission('monitoring:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.alertRule.deleteMany({ where: { id: param(req.params.id), organizationId } });
  if (!result.count) throw notFound('Alert rule');
  await audit(req, 'alert_rule.delete', 'alert_rule', param(req.params.id));
  res.status(204).end();
});

monitoringRouter.get('/alerts', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = paginationQuery.extend({ status: z.enum(['firing', 'resolved']).optional(), service: z.string().optional() }).parse(req.query);
  const service = q.service ? await requireService(organizationId, q.service) : null;
  const where: Prisma.AlertWhereInput = { organizationId, ...(q.status ? { status: q.status } : {}), ...(service ? { serviceId: service.id } : {}) };
  const [rows, total] = await Promise.all([
    prisma.alert.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      ...paginate(q),
      include: { rule: { select: { name: true, metric: true, severity: true } }, service: { select: { id: true, name: true, slug: true } }, incident: { select: { id: true, number: true } } },
    }),
    prisma.alert.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});
