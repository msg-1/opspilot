import { type LogLevel, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { assertRange, csv, paged, paginate, paginationQuery, timeParam } from '../lib/http';
import { fingerprint, parseLevel, redact, redactAttributes } from '../lib/logParsing';
import { logsIngested } from '../lib/metrics';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission } from '../middleware/auth';
import { getSettings } from './organization';

// ───────────────────────── Ingestion ─────────────────────────

const logItem = z.object({
  timestamp: z.coerce.date().optional(),
  level: z.union([z.string(), z.number()]).optional(),
  message: z.string().min(1).max(16_000),
  service: z.string().max(80).optional(),
  environment: z.string().max(40).optional(),
  host: z.string().max(200).optional(),
  traceId: z.string().max(100).optional(),
  spanId: z.string().max(100).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const ingestBody = z.object({
  /** Default service (id or slug) for entries that do not name one */
  service: z.string().max(80).optional(),
  environment: z.string().max(40).optional(),
  logs: z.array(logItem).min(1).max(5000),
});

export async function ingestLogs(organizationId: string, body: z.infer<typeof ingestBody>) {
  const settings = await getSettings(organizationId);
  const refs = [...new Set(body.logs.map((l) => l.service ?? body.service).filter((s): s is string => !!s))];
  const services = refs.length
    ? await prisma.service.findMany({ where: { organizationId, OR: [{ id: { in: refs } }, { slug: { in: refs } }] }, select: { id: true, slug: true } })
    : [];
  const byRef = new Map<string, string>();
  for (const s of services) {
    byRef.set(s.id, s.id);
    byRef.set(s.slug, s.id);
  }
  const unknown = new Set<string>();
  const now = new Date();
  const rows: Prisma.LogEntryCreateManyInput[] = body.logs.map((l) => {
    const ref = l.service ?? body.service;
    const serviceId = ref ? byRef.get(ref) : undefined;
    if (ref && !serviceId) unknown.add(ref);
    const message = settings.redactLogs ? redact(l.message) : l.message;
    const attributes = l.attributes ? (settings.redactLogs ? redactAttributes(l.attributes) : l.attributes) : undefined;
    return {
      organizationId,
      serviceId: serviceId ?? null,
      timestamp: l.timestamp ?? now,
      level: parseLevel(l.level),
      message,
      environment: l.environment ?? body.environment ?? 'production',
      host: l.host,
      traceId: l.traceId,
      spanId: l.spanId,
      fingerprint: fingerprint(message),
      attributes: (ref && !serviceId ? { ...(attributes as object | undefined), unresolvedService: ref } : attributes) as Prisma.InputJsonValue | undefined,
    };
  });
  const result = await prisma.logEntry.createMany({ data: rows });
  logsIngested.inc(result.count);
  return { accepted: result.count, unknownServices: [...unknown] };
}

// ───────────────────────── Query helpers (shared with AI tools) ─────────────────────────

export interface LogFilter {
  organizationId: string;
  from: Date;
  to: Date;
  serviceIds?: string[];
  levels?: LogLevel[];
  q?: string;
  environment?: string;
  traceId?: string;
  fingerprint?: string;
}

export async function resolveServiceIds(organizationId: string, refs?: string[]) {
  if (!refs?.length) return undefined;
  const services = await prisma.service.findMany({ where: { organizationId, OR: [{ id: { in: refs } }, { slug: { in: refs } }] }, select: { id: true } });
  // An unknown service must yield no rows rather than silently widening the search.
  return services.length ? services.map((s) => s.id) : ['__none__'];
}

function whereOf(f: LogFilter): Prisma.LogEntryWhereInput {
  return {
    organizationId: f.organizationId,
    timestamp: { gte: f.from, lte: f.to },
    ...(f.serviceIds ? { serviceId: { in: f.serviceIds } } : {}),
    ...(f.levels?.length ? { level: { in: f.levels } } : {}),
    ...(f.q ? { message: { contains: f.q, mode: 'insensitive' } } : {}),
    ...(f.environment ? { environment: f.environment } : {}),
    ...(f.traceId ? { traceId: f.traceId } : {}),
    ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
  };
}

function sqlWhere(f: LogFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`l."organizationId" = ${f.organizationId}`,
    Prisma.sql`l."timestamp" BETWEEN ${f.from} AND ${f.to}`,
  ];
  if (f.serviceIds) parts.push(Prisma.sql`l."serviceId" = ANY(${f.serviceIds})`);
  if (f.levels?.length) parts.push(Prisma.sql`l."level"::text = ANY(${f.levels})`);
  if (f.q) parts.push(Prisma.sql`l."message" ILIKE ${`%${f.q.replace(/[%_\\]/g, '\\$&')}%`}`);
  if (f.environment) parts.push(Prisma.sql`l."environment" = ${f.environment}`);
  if (f.traceId) parts.push(Prisma.sql`l."traceId" = ${f.traceId}`);
  if (f.fingerprint) parts.push(Prisma.sql`l."fingerprint" = ${f.fingerprint}`);
  return Prisma.join(parts, ' AND ');
}

export async function searchLogs(f: LogFilter, page: { page: number; pageSize: number }, order: 'asc' | 'desc' = 'desc') {
  const where = whereOf(f);
  const [rows, total] = await Promise.all([
    prisma.logEntry.findMany({
      where,
      orderBy: { timestamp: order },
      ...paginate(page),
      include: { service: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.logEntry.count({ where }),
  ]);
  return { rows, total };
}

export async function logHistogram(f: LogFilter, targetBuckets = 60) {
  const span = Math.max(60, (f.to.getTime() - f.from.getTime()) / 1000);
  const steps = [10, 30, 60, 300, 600, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86_400];
  const bucketSeconds = steps.find((s) => span / s <= targetBuckets) ?? 86_400;
  const rows = await prisma.$queryRaw<{ bucket: Date; level: LogLevel; count: bigint }[]>`
    SELECT to_timestamp(floor(extract(epoch FROM l."timestamp") / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
           l."level", count(*) AS count
    FROM "LogEntry" l WHERE ${sqlWhere(f)}
    GROUP BY 1, 2 ORDER BY 1`;
  const buckets = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const key = r.bucket.toISOString();
    const entry = buckets.get(key) ?? { timestamp: key, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0, total: 0 };
    entry[r.level] = Number(r.count);
    entry.total = Number(entry.total) + Number(r.count);
    buckets.set(key, entry);
  }
  return { bucketSeconds, buckets: [...buckets.values()] };
}

export interface LogPattern {
  fingerprint: string;
  sample: string;
  level: string;
  serviceId: string | null;
  serviceName: string | null;
  serviceSlug: string | null;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

export async function logPatterns(f: LogFilter, limit = 25): Promise<LogPattern[]> {
  const rows = await prisma.$queryRaw<(Omit<LogPattern, 'count'> & { count: bigint })[]>`
    SELECT l."fingerprint", min(l."message") AS sample, max(l."level"::text) AS level, l."serviceId",
           s."name" AS "serviceName", s."slug" AS "serviceSlug", count(*) AS count, min(l."timestamp") AS "firstSeen", max(l."timestamp") AS "lastSeen"
    FROM "LogEntry" l LEFT JOIN "Service" s ON s."id" = l."serviceId"
    WHERE ${sqlWhere(f)}
    GROUP BY l."fingerprint", l."serviceId", s."name", s."slug"
    ORDER BY count DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export interface LogAnomaly extends LogPattern {
  baselineCount: number;
  /** new = never seen in the baseline window; spike = rate at least 3x the baseline */
  kind: 'new' | 'spike';
  ratio: number | null;
}

/**
 * Compares error/warn patterns in [from, to] against the preceding baseline window
 * (default: 6x the window length, rate-normalised). Purely statistical — no LLM involved.
 */
export async function logAnomalies(f: LogFilter, baselineMultiple = 6, limit = 20): Promise<LogAnomaly[]> {
  const windowMs = f.to.getTime() - f.from.getTime();
  const baselineFrom = new Date(f.from.getTime() - windowMs * baselineMultiple);
  const levels = f.levels?.length ? f.levels : (['WARN', 'ERROR', 'FATAL'] as LogLevel[]);
  const current = await logPatterns({ ...f, levels }, 200);
  if (!current.length) return [];
  const baseline = await prisma.$queryRaw<{ fingerprint: string; serviceId: string | null; count: bigint }[]>`
    SELECT l."fingerprint", l."serviceId", count(*) AS count FROM "LogEntry" l
    WHERE ${sqlWhere({ ...f, levels, from: baselineFrom, to: new Date(f.from.getTime() - 1) })}
      AND l."fingerprint" = ANY(${current.map((c) => c.fingerprint)})
    GROUP BY l."fingerprint", l."serviceId"`;
  const base = new Map(baseline.map((b) => [`${b.fingerprint}:${b.serviceId}`, Number(b.count)]));
  const out: LogAnomaly[] = [];
  for (const p of current) {
    const baselineCount = base.get(`${p.fingerprint}:${p.serviceId}`) ?? 0;
    const expected = baselineCount / baselineMultiple;
    if (baselineCount === 0) {
      if (p.count >= 3) out.push({ ...p, baselineCount, kind: 'new', ratio: null });
    } else if (p.count >= 5 && p.count / expected >= 3) {
      out.push({ ...p, baselineCount, kind: 'spike', ratio: Math.round((p.count / expected) * 10) / 10 });
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

// ───────────────────────── Routes ─────────────────────────

const levelList = csv.transform((v) => v?.map((l) => parseLevel(l)));

const filterQuery = z.object({
  q: z.string().trim().max(200).optional(),
  service: csv,
  level: levelList,
  environment: z.string().optional(),
  traceId: z.string().optional(),
  fingerprint: z.string().optional(),
  from: timeParam.prefault('1h'),
  to: timeParam.optional(),
});

async function filterOf(organizationId: string, q: z.infer<typeof filterQuery>): Promise<LogFilter> {
  const to = q.to ?? new Date();
  assertRange(q.from, to);
  return {
    organizationId,
    from: q.from,
    to,
    serviceIds: await resolveServiceIds(organizationId, q.service),
    levels: q.level,
    q: q.q || undefined,
    environment: q.environment,
    traceId: q.traceId,
    fingerprint: q.fingerprint,
  };
}

export const logsRouter = Router();

logsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = filterQuery.merge(paginationQuery).extend({ pageSize: z.coerce.number().int().min(1).max(500).default(100), order: z.enum(['asc', 'desc']).default('desc') }).parse(req.query);
  const filter = await filterOf(organizationId, q);
  const { rows, total } = await searchLogs(filter, q, q.order);
  res.json({ ...paged(rows, total, q), range: { from: filter.from, to: filter.to } });
});

logsRouter.get('/histogram', requirePermission('read'), async (req, res) => {
  const filter = await filterOf(authOf(req).organizationId, filterQuery.parse(req.query));
  res.json({ ...(await logHistogram(filter)), range: { from: filter.from, to: filter.to } });
});

logsRouter.get('/patterns', requirePermission('read'), async (req, res) => {
  const q = filterQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  const filter = await filterOf(authOf(req).organizationId, q);
  res.json({ data: await logPatterns(filter, q.limit), range: { from: filter.from, to: filter.to } });
});

logsRouter.get('/anomalies', requirePermission('read'), async (req, res) => {
  const filter = await filterOf(authOf(req).organizationId, filterQuery.parse(req.query));
  res.json({ data: await logAnomalies(filter), range: { from: filter.from, to: filter.to } });
});

logsRouter.get('/facets', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [environments, services] = await Promise.all([
    prisma.logEntry.findMany({ where: { organizationId, timestamp: { gte: since } }, distinct: ['environment'], select: { environment: true } }),
    prisma.service.findMany({ where: { organizationId }, select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }),
  ]);
  res.json({ environments: environments.map((e) => e.environment), services, levels: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] });
});

logsRouter.post('/', requirePermission('log:write'), async (req, res) => {
  const result = await ingestLogs(authOf(req).organizationId, ingestBody.parse(req.body));
  res.status(202).json(result);
});
