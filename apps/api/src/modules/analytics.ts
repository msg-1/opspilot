import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { assertRange, param, timeParam } from '../lib/http';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission } from '../middleware/auth';
import { incidentKey, requireIncident } from './incidents';
import { createDocument } from './knowledge';
import { logHistogram } from './logs';

const minutes = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

function stats(values: number[]) {
  if (!values.length) return { count: 0, mean: null, median: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { count: sorted.length, mean: round1(sorted.reduce((a, b) => a + b, 0) / sorted.length), median: round1(at(0.5)), p90: round1(at(0.9)) };
}

const startOfWeek = (d: Date) => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
};

/** Reliability and delivery metrics for a period. All figures are computed from stored records. */
export async function analyticsOverview(organizationId: string, from: Date, to: Date) {
  const range = { gte: from, lte: to };
  const [incidents, deployments, investigations, remediations] = await Promise.all([
    prisma.incident.findMany({ where: { organizationId, startedAt: range }, include: { services: { select: { service: { select: { id: true, name: true } } } } } }),
    prisma.deployment.findMany({ where: { organizationId, startedAt: range }, select: { id: true, serviceId: true, status: true, startedAt: true, isRollback: true, service: { select: { name: true } } } }),
    prisma.investigation.findMany({ where: { organizationId, createdAt: range }, select: { status: true, confidence: true, startedAt: true, completedAt: true, provider: true } }),
    prisma.remediationAction.findMany({ where: { organizationId, createdAt: range }, select: { status: true, proposedByType: true, requestedAt: true, risk: true, approvals: { select: { createdAt: true, decision: true } } } }),
  ]);

  const bySeverity: Record<string, number> = { SEV1: 0, SEV2: 0, SEV3: 0, SEV4: 0 };
  const byService = new Map<string, { id: string; name: string; incidents: number; minutes: number }>();
  const weekly = new Map<string, { week: string; SEV1: number; SEV2: number; SEV3: number; SEV4: number; total: number }>();
  const mtta: number[] = [];
  const mttr: number[] = [];
  const mttrBySeverity: Record<string, number[]> = { SEV1: [], SEV2: [], SEV3: [], SEV4: [] };
  for (const i of incidents) {
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    const week = startOfWeek(i.startedAt);
    const w = weekly.get(week) ?? { week, SEV1: 0, SEV2: 0, SEV3: 0, SEV4: 0, total: 0 };
    w[i.severity]++;
    w.total++;
    weekly.set(week, w);
    if (i.acknowledgedAt) mtta.push(minutes(i.startedAt, i.acknowledgedAt));
    if (i.resolvedAt) {
      const m = minutes(i.startedAt, i.resolvedAt);
      mttr.push(m);
      mttrBySeverity[i.severity]!.push(m);
    }
    for (const { service } of i.services) {
      const s = byService.get(service.id) ?? { id: service.id, name: service.name, incidents: 0, minutes: 0 };
      s.incidents++;
      s.minutes += minutes(i.startedAt, i.resolvedAt ?? to);
      byService.set(service.id, s);
    }
  }

  // Change failure rate (DORA): a deployment "failed" if it failed, was rolled back, or an
  // incident on the same service started within 6 hours after it.
  const incidentStarts = incidents.flatMap((i) => i.services.map((s) => ({ serviceId: s.service.id, at: i.startedAt.getTime() })));
  const production = deployments.filter((d) => !d.isRollback);
  const failed = production.filter(
    (d) => d.status === 'FAILED' || d.status === 'ROLLED_BACK' || incidentStarts.some((s) => s.serviceId === d.serviceId && s.at >= d.startedAt.getTime() && s.at <= d.startedAt.getTime() + 6 * 3600_000),
  );
  const days = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);
  const deploysByDay = new Map<string, number>();
  for (const d of deployments) {
    const key = d.startedAt.toISOString().slice(0, 10);
    deploysByDay.set(key, (deploysByDay.get(key) ?? 0) + 1);
  }
  const deploysByService = new Map<string, number>();
  for (const d of deployments) deploysByService.set(d.service.name, (deploysByService.get(d.service.name) ?? 0) + 1);

  const completed = investigations.filter((i) => i.status === 'COMPLETED');
  const approvalTimes = remediations.flatMap((r) => (r.requestedAt && r.approvals.length ? [minutes(r.requestedAt, r.approvals[r.approvals.length - 1]!.createdAt)] : []));
  const count = <T extends string>(items: { status: T }[]) => items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});

  return {
    range: { from, to },
    incidents: {
      total: incidents.length,
      open: incidents.filter((i) => !['RESOLVED', 'CLOSED'].includes(i.status)).length,
      bySeverity,
      byStatus: count(incidents),
      weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
      topServices: [...byService.values()].sort((a, b) => b.incidents - a.incidents).slice(0, 8).map((s) => ({ ...s, minutes: Math.round(s.minutes) })),
      mttaMinutes: stats(mtta),
      mttrMinutes: stats(mttr),
      mttrBySeverity: Object.fromEntries(Object.entries(mttrBySeverity).map(([k, v]) => [k, stats(v)])),
    },
    deployments: {
      total: deployments.length,
      perDay: round1(deployments.length / days),
      rollbacks: deployments.filter((d) => d.isRollback).length,
      changeFailureRate: production.length ? round1((failed.length / production.length) * 100) : null,
      failedChanges: failed.length,
      daily: [...deploysByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, total]) => ({ date, total })),
      byService: [...deploysByService.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, total]) => ({ name, total })),
    },
    investigations: {
      total: investigations.length,
      byStatus: count(investigations),
      averageConfidence: completed.length ? round1((completed.reduce((a, i) => a + (i.confidence ?? 0), 0) / completed.length) * 100) : null,
      durationSeconds: stats(completed.flatMap((i) => (i.startedAt && i.completedAt ? [(i.completedAt.getTime() - i.startedAt.getTime()) / 1000] : []))),
      byProvider: completed.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.provider ?? 'unknown']: (acc[i.provider ?? 'unknown'] ?? 0) + 1 }), {}),
    },
    remediation: {
      total: remediations.length,
      byStatus: count(remediations),
      proposedByAi: remediations.filter((r) => r.proposedByType === 'ai_agent').length,
      approvalMinutes: stats(approvalTimes),
    },
  };
}

export const analyticsRouter = Router();
const rangeQuery = z.object({ from: timeParam.default('30d'), to: timeParam.optional() });

analyticsRouter.get('/overview', requirePermission('read'), async (req, res) => {
  const q = rangeQuery.parse(req.query);
  const to = q.to ?? new Date();
  assertRange(q.from, to, 366);
  res.json(await analyticsOverview(authOf(req).organizationId, q.from, to));
});

/** Incident report export (CSV) for the period. */
analyticsRouter.get('/incidents.csv', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = rangeQuery.parse(req.query);
  const to = q.to ?? new Date();
  assertRange(q.from, to, 366);
  const incidents = await prisma.incident.findMany({
    where: { organizationId, startedAt: { gte: q.from, lte: to } },
    orderBy: { startedAt: 'desc' },
    include: { services: { select: { service: { select: { name: true } } } } },
  });
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    'key,title,severity,status,services,started_at,acknowledged_at,resolved_at,minutes_to_acknowledge,minutes_to_resolve,root_cause',
    ...incidents.map((i) =>
      [
        incidentKey(i.number),
        i.title,
        i.severity,
        i.status,
        i.services.map((s) => s.service.name).join('; '),
        i.startedAt.toISOString(),
        i.acknowledgedAt?.toISOString(),
        i.resolvedAt?.toISOString(),
        i.acknowledgedAt ? Math.round(minutes(i.startedAt, i.acknowledgedAt)) : '',
        i.resolvedAt ? Math.round(minutes(i.startedAt, i.resolvedAt)) : '',
        i.rootCause,
      ]
        .map(esc)
        .join(','),
    ),
  ];
  await audit(req, 'report.export', 'report', null, { type: 'incidents', rows: incidents.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="opspilot-incidents.csv"');
  res.send(lines.join('\n'));
});

// ───────────────────────── Dashboard ─────────────────────────

export const dashboardRouter = Router();

dashboardRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [activeIncidents, health, deployments, investigations, pendingApprovals, firingAlerts, errorTrend, weekIncidents, resolved, deploys24h] = await Promise.all([
    prisma.incident.findMany({
      where: { organizationId, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      orderBy: [{ severity: 'asc' }, { startedAt: 'desc' }],
      take: 8,
      include: { services: { select: { service: { select: { id: true, name: true, slug: true } } } } },
    }),
    prisma.service.groupBy({ by: ['health'], where: { organizationId }, _count: true }),
    prisma.deployment.findMany({ where: { organizationId }, orderBy: { startedAt: 'desc' }, take: 6, include: { service: { select: { id: true, name: true, slug: true } } } }),
    prisma.investigation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, question: true, status: true, confidence: true, createdAt: true, incident: { select: { number: true } } },
    }),
    prisma.remediationAction.findMany({ where: { organizationId, status: 'PENDING_APPROVAL' }, orderBy: { requestedAt: 'desc' }, take: 5, select: { id: true, title: true, risk: true, type: true, requestedAt: true, requiredApprovals: true, _count: { select: { approvals: true } } } }),
    prisma.alert.count({ where: { organizationId, status: 'firing' } }),
    logHistogram({ organizationId, from: dayAgo, to: now, levels: ['ERROR', 'FATAL', 'WARN'] }, 48),
    prisma.incident.count({ where: { organizationId, startedAt: { gte: weekAgo } } }),
    prisma.incident.findMany({ where: { organizationId, resolvedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } }, select: { startedAt: true, resolvedAt: true } }),
    prisma.deployment.count({ where: { organizationId, startedAt: { gte: dayAgo } } }),
  ]);
  const names = new Map(
    (await prisma.user.findMany({ where: { id: { in: activeIncidents.flatMap((i) => (i.assigneeId ? [i.assigneeId] : [])) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  res.json({
    activeIncidents: activeIncidents.map((i) => ({ id: i.id, key: incidentKey(i.number), title: i.title, severity: i.severity, status: i.status, startedAt: i.startedAt, services: i.services.map((s) => s.service), assignee: i.assigneeId ? { id: i.assigneeId, name: names.get(i.assigneeId) ?? 'Unknown' } : null })),
    counts: {
      activeIncidents: await prisma.incident.count({ where: { organizationId, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
      incidentsThisWeek: weekIncidents,
      firingAlerts,
      deploymentsLast24h: deploys24h,
      pendingApprovals: await prisma.remediationAction.count({ where: { organizationId, status: 'PENDING_APPROVAL' } }),
      mttrMinutes30d: stats(resolved.map((r) => minutes(r.startedAt, r.resolvedAt!))).median,
    },
    serviceHealth: Object.fromEntries((['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const).map((h) => [h, health.find((x) => x.health === h)?._count ?? 0])),
    recentDeployments: deployments,
    recentInvestigations: investigations,
    pendingApprovals: pendingApprovals.map(({ _count, ...p }) => ({ ...p, approvalsRecorded: _count.approvals })),
    errorTrend: errorTrend.buckets.map((b) => ({ timestamp: b.timestamp, errors: Number(b.ERROR) + Number(b.FATAL), warnings: Number(b.WARN) })),
  });
});

// ───────────────────────── Postmortem drafts ─────────────────────────

export const postmortemRouter = Router();

/**
 * Assembles a postmortem draft from recorded facts (timeline, investigation results,
 * remediation history) and stores it in the knowledge base so future investigations can
 * retrieve it. This is a deterministic template, not generated prose.
 */
postmortemRouter.post('/:id/postmortem', requirePermission('knowledge:write'), async (req, res) => {
  const auth = authOf(req);
  const incident = await requireIncident(auth.organizationId, param(req.params.id));
  const existing = await prisma.knowledgeDocument.findUnique({ where: { incidentId: incident.id }, select: { id: true } });
  if (existing) {
    res.json({ id: existing.id, created: false });
    return;
  }
  const [events, investigation, remediations] = await Promise.all([
    prisma.incidentEvent.findMany({ where: { incidentId: incident.id, type: { not: 'comment' } }, orderBy: { createdAt: 'asc' } }),
    prisma.investigation.findFirst({ where: { incidentId: incident.id, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, include: { hypotheses: { orderBy: { rank: 'asc' }, take: 3 } } }),
    prisma.remediationAction.findMany({ where: { incidentId: incident.id }, orderBy: { createdAt: 'asc' } }),
  ]);
  const key = incidentKey(incident.number);
  const fmt = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
  const duration = incident.resolvedAt ? `${Math.round(minutes(incident.startedAt, incident.resolvedAt))} minutes` : 'ongoing';
  const content = [
    `# Postmortem: ${key} — ${incident.title}`,
    '',
    '## Summary',
    `- **Severity:** ${incident.severity}`,
    `- **Status:** ${incident.status}`,
    `- **Services affected:** ${incident.services.map((s) => s.service.name).join(', ') || 'none recorded'}`,
    `- **Started:** ${fmt(incident.startedAt)}`,
    `- **Mitigated:** ${fmt(incident.mitigatedAt)}`,
    `- **Resolved:** ${fmt(incident.resolvedAt)}`,
    `- **Duration:** ${duration}`,
    '',
    incident.description ?? '',
    '',
    '## Customer impact',
    incident.customerImpact ?? '_Not recorded. Describe who was affected and how._',
    '',
    '## Root cause',
    incident.rootCause ?? '_Not yet confirmed by the incident team._',
    '',
    '## Resolution',
    incident.resolution ?? '_Not recorded._',
    '',
    ...(investigation
      ? [
          '## AI investigation findings (unconfirmed)',
          `Analysis by ${investigation.provider ?? 'unknown'}${investigation.model ? ` / ${investigation.model}` : ''}, overall confidence ${Math.round((investigation.confidence ?? 0) * 100)}%. These are hypotheses, not confirmed causes.`,
          '',
          investigation.summary ?? '',
          '',
          ...investigation.hypotheses.map((h) => `${h.rank}. **${h.title}** (${Math.round(h.confidence * 100)}%, ${h.status}) — ${h.description}`),
          '',
        ]
      : []),
    '## Timeline',
    ...events.map((e) => `- ${fmt(e.createdAt)} — ${e.message}${e.actorLabel ? ` _(${e.actorLabel})_` : ''}`),
    '',
    '## Remediation actions',
    ...(remediations.length ? remediations.map((r) => `- **${r.title}** — ${r.status.toLowerCase().replace(/_/g, ' ')} (${r.risk.toLowerCase()} risk)`) : ['_None recorded._']),
    '',
    '## Lessons learned',
    '_What went well, what went poorly, where we got lucky._',
    '',
    '## Follow-up actions',
    '_Owner, action, due date._',
  ].join('\n');
  const doc = await createDocument(auth.organizationId, { title: `Postmortem: ${key} — ${incident.title}`, type: 'postmortem', content, tags: ['postmortem', incident.severity.toLowerCase()], service: incident.services[0]?.service.id, incidentId: incident.id }, auth.userId);
  await audit(req, 'postmortem.create', 'knowledge_document', doc.id, { incident: key });
  res.status(201).json({ id: doc.id, created: true });
});
