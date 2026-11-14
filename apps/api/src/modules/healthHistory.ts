import type { HealthStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

// Kept apart from monitoring.ts and incidents.ts, which both use it and already depend on each other.
const STALE_AFTER_MS = 15 * 60_000;
const incidentKey = (number: number) => `INC-${number}`;

export type HealthBasis = { health: HealthStatus; note: string };

/** A window counts as past when it ended before the last health computation could still describe it. */
export const isPastWindow = (to: Date, now = new Date()) => now.getTime() - to.getTime() > STALE_AFTER_MS;

/**
 * What the health of services was during a past window, worked out from what was recorded at
 * the time, by the same rule that computes health now (recomputeHealth): an alert that was
 * firing, an incident that was open, telemetry that was arriving. Nothing is assumed: a service
 * with no alert, no incident and no telemetry in the window is UNKNOWN, not healthy.
 *
 * The health column on a service is its state now and is never used here. `excludeIncidentId`
 * leaves out the incident being investigated, which cannot be evidence for its own cause.
 */
export async function healthDuring(organizationId: string, serviceIds: string[], from: Date, to: Date, excludeIncidentId?: string | null): Promise<Map<string, HealthBasis>> {
  const out = new Map<string, HealthBasis>();
  if (!serviceIds.length) return out;
  const overlaps = { startedAt: { lte: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] };
  const [alerts, incidents, telemetry] = await Promise.all([
    prisma.alert.findMany({ where: { organizationId, serviceId: { in: serviceIds }, ...overlaps }, select: { serviceId: true, startedAt: true, resolvedAt: true, rule: { select: { severity: true, name: true } } } }),
    prisma.incidentService.findMany({
      where: { serviceId: { in: serviceIds }, incident: { organizationId, ...(excludeIncidentId ? { id: { not: excludeIncidentId } } : {}), ...overlaps } },
      select: { serviceId: true, incident: { select: { severity: true, number: true, startedAt: true, resolvedAt: true } } },
    }),
    prisma.metricSample.groupBy({ by: ['serviceId'], where: { organizationId, serviceId: { in: serviceIds }, timestamp: { gte: from, lte: to } } }),
  ]);
  const reported = new Set(telemetry.map((t) => t.serviceId));
  const span = (start: Date, end: Date | null) => `from ${start.toISOString()} ${end ? `to ${end.toISOString()}` : 'and has not been resolved'}`;
  for (const id of serviceIds) {
    const mine = alerts.filter((a) => a.serviceId === id);
    const open = incidents.filter((i) => i.serviceId === id).map((i) => i.incident);
    const criticalAlert = mine.find((a) => a.rule.severity === 'SEV1');
    const criticalIncident = open.find((i) => i.severity === 'SEV1');
    if (criticalAlert) out.set(id, { health: 'DOWN', note: `Critical alert "${criticalAlert.rule.name}" was firing ${span(criticalAlert.startedAt, criticalAlert.resolvedAt)}` });
    else if (criticalIncident) out.set(id, { health: 'DOWN', note: `SEV1 incident ${incidentKey(criticalIncident.number)} was open ${span(criticalIncident.startedAt, criticalIncident.resolvedAt)}` });
    else if (mine.length) out.set(id, { health: 'DEGRADED', note: `Alert "${mine[0]!.rule.name}" was firing ${span(mine[0]!.startedAt, mine[0]!.resolvedAt)}${mine.length > 1 ? ` (and ${mine.length - 1} more)` : ''}` });
    else if (open.length) out.set(id, { health: 'DEGRADED', note: `Incident ${incidentKey(open[0]!.number)} was open ${span(open[0]!.startedAt, open[0]!.resolvedAt)}` });
    else if (reported.has(id)) out.set(id, { health: 'HEALTHY', note: 'No alert or incident is recorded for it in the window, and it was sending metrics' });
    else out.set(id, { health: 'UNKNOWN', note: 'Nothing is recorded for it in the window: no alert, no incident and no metrics' });
  }
  return out;
}
