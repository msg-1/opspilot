import { describe, expect, it } from 'vitest';
import { recomputeHealth } from '../src/modules/monitoring';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

// What the tool API tells an investigation about the health of a service and of what it
// depends on. For a window that is over, the answer must come from what was recorded then
// (alerts, incidents, telemetry), never from the state of the service today.
type Org = Awaited<ReturnType<typeof createOrg>>;
const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

async function world(org: Org) {
  const [checkout, redis, payments, ledger] = [await createService(org.owner, 'Checkout'), await createService(org.owner, 'Redis'), await createService(org.owner, 'Payments'), await createService(org.owner, 'Ledger')];
  await org.owner.put(`/api/v1/services/${checkout.id}/dependencies`).send({ dependencies: [{ serviceId: redis.id, kind: 'datastore' }, { serviceId: payments.id }, { serviceId: ledger.id }] }).expect(200);
  const rule = (serviceId: string, name: string, severity: 'SEV1' | 'SEV3') => prisma.alertRule.create({ data: { organizationId: org.organizationId, serviceId, name, metric: 'error_rate', threshold: 5, severity } });
  const metric = (serviceId: string, hoursAgo: number) => prisma.metricSample.create({ data: { organizationId: org.organizationId, serviceId, metric: 'error_rate', value: 0.2, timestamp: ago(hoursAgo) } });
  // Three days ago: Redis was down for an hour. Payments was fine and reporting. Ledger sent nothing.
  const redisDown = await rule(redis.id, 'Redis unavailable', 'SEV1');
  await prisma.alert.create({ data: { organizationId: org.organizationId, ruleId: redisDown.id, serviceId: redis.id, status: 'resolved', value: 100, message: 'redis_up below 1', startedAt: ago(73), resolvedAt: ago(72) } });
  await metric(payments.id, 72.5);
  await metric(checkout.id, 72.5);
  // Today: Redis is fine and reporting. Payments is down, as of ten minutes ago.
  await metric(redis.id, 0.05);
  await metric(checkout.id, 0.05);
  const paymentsDown = await rule(payments.id, 'Payments error rate critical', 'SEV1');
  await prisma.alert.create({ data: { organizationId: org.organizationId, ruleId: paymentsDown.id, serviceId: payments.id, status: 'firing', value: 60, message: 'error_rate above 5', startedAt: ago(0.15) } });
  await recomputeHealth(org.organizationId);
  const key = await createApiKey(org.owner, ['tools:read']);
  const ask = async (query = '') => (await api().get(`/api/v1/tools/services/checkout${query}`).set('x-api-key', key).expect(200)).body;
  const window = (fromHours: number, toHours: number) => `?from=${encodeURIComponent(ago(fromHours).toISOString())}&to=${encodeURIComponent(ago(toHours).toISOString())}`;
  return { checkout, redis, payments, ledger, key, ask, window };
}
const healthOf = (body: { dependsOn: { slug: string; health: string }[] }) => Object.fromEntries(body.dependsOn.map((d) => [d.slug, d.health]));

describe('health as an investigation is told it', () => {
  it('describes a past window from what was recorded then, not from today', async () => {
    const org = await createOrg();
    const { ask, window } = await world(org);

    // Asked about now: Payments is down, Redis is not.
    const now = await ask();
    expect(now.healthAsOf).toMatchObject({ mode: 'current' });
    expect(healthOf(now)).toEqual({ redis: 'HEALTHY', payments: 'DOWN', ledger: 'UNKNOWN' });

    // Asked about the hours around the outage three days ago: the other way round.
    const then = await ask(window(74, 71));
    expect(then.healthAsOf).toMatchObject({ mode: 'window' });
    expect(healthOf(then)).toEqual({ redis: 'DOWN', payments: 'HEALTHY', ledger: 'UNKNOWN' });
    const byslug = Object.fromEntries(then.dependsOn.map((d: { slug: string; healthNote: string }) => [d.slug, d.healthNote]));
    // It says what the conclusion rests on, with the times from the record.
    expect(byslug.redis).toMatch(/^Critical alert "Redis unavailable" was firing from \d{4}-.* to \d{4}-/);
    expect(byslug.payments).toContain('No alert or incident is recorded for it in the window, and it was sending metrics');
    // Nothing on record is said to be nothing on record. It is not called healthy.
    expect(byslug.ledger).toContain('Nothing is recorded for it in the window');
    // Today's outage of Payments appears nowhere in the answer about three days ago.
    expect(JSON.stringify(then)).not.toContain('Payments error rate critical');
    expect(then).toMatchObject({ health: 'HEALTHY', firingAlerts: [] });

    // A day before the outage, Redis has no record at all: unknown, not healthy and not down.
    expect(healthOf(await ask(window(100, 98)))).toEqual({ redis: 'UNKNOWN', payments: 'UNKNOWN', ledger: 'UNKNOWN' });
    // A window that reaches the present is about the present.
    const reaching = await ask(window(2, 0));
    expect(reaching.healthAsOf.mode).toBe('current');
    expect(healthOf(reaching).payments).toBe('DOWN');
    // An alert that began in the window and is still firing counts for the window too.
    const overlapping = await ask(window(1, 0.4));
    expect(overlapping.healthAsOf.mode).toBe('window');
    expect(healthOf(overlapping)).toMatchObject({ payments: 'UNKNOWN' }); // it began after this window ended
    expect(healthOf(await ask(window(1, 0.26)))).toMatchObject({ payments: 'UNKNOWN' });

    // Another organisation's key learns nothing.
    const other = await createOrg();
    const otherKey = await createApiKey(other.owner, ['tools:read']);
    expect((await api().get(`/api/v1/tools/services/checkout${window(74, 71)}`).set('x-api-key', otherKey)).status).toBe(404);
  });

  it('gives the context of a resolved incident with health from its own time, and does not count the incident as proof of itself', async () => {
    const org = await createOrg();
    const { checkout, redis, payments } = await world(org);
    // The incident under investigation: three days ago, on Checkout and (as recorded by whoever declared it) Redis.
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing on cache lookups', severity: 'SEV2', serviceIds: [checkout.id, redis.id] }).expect(201)).body;
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', startedAt: ago(73), resolvedAt: ago(71.5) } });
    // An earlier incident on Payments that was long over by then, and one that was open at the time.
    const old = (await org.owner.post('/api/v1/incidents').send({ title: 'Payments slow', severity: 'SEV3', serviceIds: [payments.id] }).expect(201)).body;
    await prisma.incident.update({ where: { id: old.id }, data: { status: 'RESOLVED', startedAt: ago(200), resolvedAt: ago(190) } });

    const context = (await org.owner.get(`/api/v1/incidents/${incident.id}/context`).expect(200)).body;
    expect(context.healthAsOf).toMatchObject({ mode: 'window' });
    const deps = Object.fromEntries(context.upstreamDependencies.map((d: { slug: string; health: string; healthNote: string }) => [d.slug, d]));
    // Redis: down then, by the alert recorded then. Not degraded "because this incident names it".
    expect(deps.redis).toMatchObject({ health: 'DOWN', healthNote: expect.stringContaining('Redis unavailable') });
    // Payments is down today and was fine then. Its old, closed incident does not reach into the window.
    expect(deps.payments).toMatchObject({ health: 'HEALTHY' });
    expect(deps.ledger).toMatchObject({ health: 'UNKNOWN' });

    // Remove the alert: all that is left naming Redis is the incident itself, which proves nothing about Redis.
    await prisma.alert.deleteMany({ where: { serviceId: redis.id } });
    const without = (await org.owner.get(`/api/v1/incidents/${incident.id}/context`).expect(200)).body;
    expect(without.upstreamDependencies.find((d: { slug: string }) => d.slug === 'redis')).toMatchObject({ health: 'UNKNOWN' });
    // A different incident that was open on Payments during the window does count.
    await prisma.incident.update({ where: { id: old.id }, data: { startedAt: ago(74), resolvedAt: ago(72) } });
    const withOther = (await org.owner.get(`/api/v1/incidents/${incident.id}/context`).expect(200)).body;
    expect(withOther.upstreamDependencies.find((d: { slug: string }) => d.slug === 'payments')).toMatchObject({ health: 'DEGRADED', healthNote: expect.stringMatching(/^Incident INC-\d+ was open from /) });

    // While an incident is still open, today is part of it: current health is the right answer.
    const open = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing at payment', severity: 'SEV2', serviceIds: [checkout.id] }).expect(201)).body;
    const live = (await org.owner.get(`/api/v1/incidents/${open.id}/context`).expect(200)).body;
    expect(live.healthAsOf.mode).toBe('current');
    expect(live.upstreamDependencies.find((d: { slug: string }) => d.slug === 'payments')).toMatchObject({ health: 'DOWN' });
  });
});
