import { describe, expect, it } from 'vitest';
import { evaluateAlerts } from '../src/modules/monitoring';
import { applyRetention } from '../src/modules/system';
import { api, createApiKey, createOrg, createService, minutesAgo, prisma } from './helpers';

describe('services and deployments', () => {
  it('manages the catalogue, dependencies and the dependency graph', async () => {
    const org = await createOrg();
    const [web, apiSvc, db] = await Promise.all([createService(org.owner, 'Web App'), createService(org.owner, 'Orders API'), createService(org.owner, 'Orders DB')]);
    expect(web.slug).toBe('web-app');
    expect((await org.owner.post('/api/v1/services').send({ name: 'Web App' })).status).toBe(409);
    await org.owner.put(`/api/v1/services/${web.id}/dependencies`).send({ dependencies: [{ serviceId: apiSvc.id }] }).expect(200);
    await org.owner.put(`/api/v1/services/orders-api/dependencies`).send({ dependencies: [{ serviceId: db.id, kind: 'datastore' }] }).expect(200);
    expect((await org.owner.put(`/api/v1/services/${web.id}/dependencies`).send({ dependencies: [{ serviceId: web.id }] })).status).toBe(400);
    const graph = (await org.owner.get('/api/v1/services/graph')).body;
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual(expect.arrayContaining([{ from: web.id, to: apiSvc.id, kind: 'sync' }, { from: apiSvc.id, to: db.id, kind: 'datastore' }]));
    const detail = (await org.owner.get('/api/v1/services/orders-api')).body;
    expect(detail.dependencies.map((d: { slug: string }) => d.slug)).toEqual(['orders-db']);
    expect(detail.dependents.map((d: { slug: string }) => d.slug)).toEqual(['web-app']);
    expect((await org.owner.get('/api/v1/services?q=orders')).body.data).toHaveLength(2);
  });

  it('records deployments via API key and links later incidents to them', async () => {
    const org = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    const key = await createApiKey(org.owner, ['ingest:deployments', 'ingest:events']);
    await api().post('/api/v1/deployments').set('x-api-key', key).send({ service: 'checkout', version: 'v1.0.0', startedAt: minutesAgo(600) }).expect(201);
    const dep = await api().post('/api/v1/deployments').set('x-api-key', key).send({ service: 'checkout', version: 'v1.1.0', commitSha: 'abc1234def', startedAt: minutesAgo(30) });
    expect(dep.body).toMatchObject({ version: 'v1.1.0', source: 'api', status: 'SUCCEEDED' });
    expect((await api().post('/api/v1/deployments').set('x-api-key', key).send({ service: 'nope', version: 'v1' })).status).toBe(404);
    await api().post('/api/v1/service-events').set('x-api-key', key).send({ service: 'checkout', type: 'feature_flag', title: 'Flag fast_checkout on' }).expect(201);
    await org.owner.post('/api/v1/incidents').send({ title: 'Checkout errors after deploy', serviceIds: [service.id], startedAt: minutesAgo(10) }).expect(201);
    const detail = (await org.owner.get(`/api/v1/deployments/${dep.body.id}`)).body;
    expect(detail.previousDeployment.version).toBe('v1.0.0');
    expect(detail.incidentsAfter).toHaveLength(1);
    expect((await org.owner.get('/api/v1/deployments?service=checkout')).body.meta.total).toBe(2);
    expect((await org.owner.get('/api/v1/service-events?type=feature_flag')).body.data[0].title).toBe('Flag fast_checkout on');
  });
});

describe('incidents', () => {
  it('numbers incidents per organisation and tracks the lifecycle with timestamps and a timeline', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const engineer = await org.member('ENGINEER', 'Erin Engineer');
    const service = await createService(org.owner);
    const first = (await org.owner.post('/api/v1/incidents').send({ title: 'Database latency high', severity: 'SEV2', serviceIds: [service.id] })).body;
    const second = (await org.owner.post('/api/v1/incidents').send({ title: 'Second incident here', severity: 'SEV4' })).body;
    expect([first.key, second.key]).toEqual(['INC-1', 'INC-2']);
    expect((await other.owner.post('/api/v1/incidents').send({ title: 'Other org starts at one' })).body.key).toBe('INC-1');

    const investigating = (await org.owner.patch(`/api/v1/incidents/${first.id}`).send({ status: 'INVESTIGATING', assigneeId: engineer.userId })).body;
    expect(investigating.acknowledgedAt).toBeTruthy();
    expect(investigating.assignee.name).toBe('Erin Engineer');
    expect((await org.owner.patch(`/api/v1/incidents/${first.id}`).send({ status: 'CLOSED' })).status).toBe(400);
    const resolved = (await org.owner.patch(`/api/v1/incidents/INC-1`).send({ status: 'RESOLVED', rootCause: 'Missing index', resolution: 'Added index', severity: 'SEV3' })).body;
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.mitigatedAt).toBeTruthy();
    await org.owner.patch(`/api/v1/incidents/${first.id}`).send({ status: 'CLOSED' }).expect(200);
    const reopened = (await org.owner.patch(`/api/v1/incidents/${first.id}`).send({ status: 'INVESTIGATING' })).body;
    expect(reopened.resolvedAt).toBeNull();

    const detail = (await org.owner.get(`/api/v1/incidents/${first.id}`)).body;
    const types = detail.timeline.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['created', 'status_change', 'assignment', 'severity_change', 'update']));
    expect((await engineer.agent.get('/api/v1/notifications')).body.data[0]).toMatchObject({ type: 'incident.assigned' });

    const list = await org.owner.get('/api/v1/incidents?active=true&severity=SEV3');
    expect(list.body.data.map((i: { key: string }) => i.key)).toEqual(['INC-1']);
    expect((await org.owner.get('/api/v1/incidents?q=inc-2')).body.data[0].title).toBe('Second incident here');
    expect((await org.owner.get(`/api/v1/incidents?service=${service.slug}`)).body.meta.total).toBe(1);
  });

  it('supports comments with @mentions and builds investigation context', async () => {
    const org = await createOrg();
    const engineer = await org.member('ENGINEER', 'Sam Rivera');
    const [checkout, db] = await Promise.all([createService(org.owner, 'Checkout'), createService(org.owner, 'Orders DB')]);
    await org.owner.put(`/api/v1/services/${checkout.id}/dependencies`).send({ dependencies: [{ serviceId: db.id, kind: 'datastore' }] });
    await org.owner.post('/api/v1/deployments').send({ service: 'orders-db', version: 'pg-16.4', startedAt: minutesAgo(90) });
    await org.owner.post('/api/v1/logs').send({ service: 'checkout', logs: Array.from({ length: 5 }, (_, i) => ({ level: 'error', message: `timeout acquiring connection after ${3000 + i}ms`, timestamp: minutesAgo(20 - i) })) });
    const old = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing with timeouts', serviceIds: [checkout.id], startedAt: minutesAgo(60 * 24 * 10) })).body;
    await org.owner.patch(`/api/v1/incidents/${old.id}`).send({ status: 'RESOLVED', rootCause: 'Pool too small' });
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing with timeouts again', serviceIds: [checkout.id], startedAt: minutesAgo(30) })).body;

    await org.owner.post(`/api/v1/incidents/${incident.id}/comments`).send({ message: 'Can you look at the pool, @Sam Rivera?' }).expect(201);
    const notes = (await engineer.agent.get('/api/v1/notifications')).body;
    expect(notes.unread).toBe(1);
    expect(notes.data[0].type).toBe('incident.comment');
    await engineer.agent.post('/api/v1/notifications/read').send({}).expect(204);
    expect((await engineer.agent.get('/api/v1/notifications')).body.unread).toBe(0);

    const ctx = (await org.owner.get(`/api/v1/incidents/${incident.id}/context`)).body;
    expect(ctx.upstreamDependencies.map((d: { slug: string }) => d.slug)).toEqual(['orders-db']);
    expect(ctx.deployments.map((d: { version: string }) => d.version)).toEqual(['pg-16.4']); // upstream change is in scope
    expect(ctx.errorPatterns[0]).toMatchObject({ count: 5, serviceSlug: 'checkout' });
    expect(ctx.similarIncidents[0]).toMatchObject({ key: old.key, rootCause: 'Pool too small' });
  });
});

describe('logs', () => {
  it('redacts secrets, groups by pattern, searches, and detects anomalies against a baseline', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Payments');
    const baseline = Array.from({ length: 12 }, (_, i) => ({ level: 'warn', message: `retrying provider call attempt=${i}`, timestamp: minutesAgo(200 + i * 10) }));
    const steady = Array.from({ length: 2 }, (_, i) => ({ level: 'warn', message: `retrying provider call attempt=${i}`, timestamp: minutesAgo(10 + i) }));
    const burst = Array.from({ length: 30 }, (_, i) => ({ level: 'ERROR', message: `card declined by provider code=${5000 + i} user=${i}@example.com`, timestamp: minutesAgo(1 + i), traceId: i === 0 ? 'trace-1' : undefined }));
    const secrets = [{ level: 50, message: 'login failed password=hunter2secret token: Bearer abcdefghijklmnopqrstuvwxyz', attributes: { apiKey: 'sk-live-123', nested: { note: 'card 4111 1111 1111 1111' } } }];
    const res = await org.owner.post('/api/v1/logs').send({ service: 'payments', logs: [...baseline, ...steady, ...burst, ...secrets, { service: 'ghost', message: 'from unknown service' }] });
    expect(res.body).toEqual({ accepted: 46, unknownServices: ['ghost'] });

    const secret = (await org.owner.get('/api/v1/logs?q=login failed')).body.data[0];
    expect(secret.level).toBe('ERROR');
    expect(secret.message).not.toMatch(/hunter2secret|abcdefghijklmnop/);
    expect(JSON.stringify(secret.attributes)).not.toMatch(/sk-live-123|4111/);

    const patterns = (await org.owner.get('/api/v1/logs/patterns?from=1h&level=error')).body.data;
    expect(patterns[0]).toMatchObject({ count: 30, level: 'ERROR', serviceSlug: 'payments' });
    const byTrace = (await org.owner.get('/api/v1/logs?traceId=trace-1')).body;
    expect(byTrace.meta.total).toBe(1);
    expect((await org.owner.get(`/api/v1/logs?fingerprint=${patterns[0].fingerprint}&pageSize=5`)).body.meta.total).toBe(30);
    expect((await org.owner.get('/api/v1/logs?service=does-not-exist')).body.meta.total).toBe(0);
    expect((await org.owner.get('/api/v1/logs?from=notadate')).status).toBe(400);

    const anomalies = (await org.owner.get('/api/v1/logs/anomalies?from=40m')).body.data;
    expect(anomalies).toHaveLength(1); // the steady retry warning is not anomalous
    expect(anomalies[0]).toMatchObject({ kind: 'new', count: 30, baselineCount: 0 });
    const histogram = (await org.owner.get('/api/v1/logs/histogram?from=1h')).body;
    expect(histogram.buckets.reduce((a: number, b: { ERROR: number }) => a + b.ERROR, 0)).toBe(31);
  });

  it('applies the retention period', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Old');
    await org.owner.patch('/api/v1/settings').send({ logRetentionDays: 7 }).expect(200);
    await org.owner.post('/api/v1/logs').send({ service: 'old', logs: [{ message: 'ancient', timestamp: minutesAgo(60 * 24 * 9) }, { message: 'recent' }] });
    await applyRetention();
    const left = await prisma.logEntry.findMany({ where: { organizationId: org.organizationId } });
    expect(left.map((l) => l.message)).toEqual(['recent']);
  });
});

describe('monitoring', () => {
  it('fires an alert, opens an incident, degrades health, then resolves', async () => {
    const org = await createOrg();
    const service = await createService(org.owner, 'Search');
    const rule = (await org.owner.post('/api/v1/monitoring/alert-rules').send({ service: 'search', name: 'Error rate high', metric: 'error_rate', threshold: 5, severity: 'SEV2', autoIncident: true })).body;
    const send = (value: number) => org.owner.post('/api/v1/monitoring/metrics').send({ samples: [{ service: 'search', metric: 'error_rate', value }, { service: 'ghost', metric: 'error_rate', value: 1 }] });
    expect((await send(0.5)).body).toMatchObject({ accepted: 1, rejected: 1, unknownServices: ['ghost'] });
    expect(await evaluateAlerts(org.organizationId)).toMatchObject({ fired: 0 });
    expect((await org.owner.get(`/api/v1/services/${service.id}`)).body.health).toBe('HEALTHY');

    await prisma.metricSample.deleteMany({ where: { organizationId: org.organizationId } });
    await send(42);
    expect(await evaluateAlerts(org.organizationId)).toMatchObject({ fired: 1 });
    expect(await evaluateAlerts(org.organizationId)).toMatchObject({ fired: 0 }); // no duplicate alert
    const overview = (await org.owner.get('/api/v1/monitoring/overview')).body;
    expect(overview.firingAlerts).toHaveLength(1);
    expect(overview.firingAlerts[0].incident.number).toBe(1);
    expect(overview.services[0]).toMatchObject({ health: 'DEGRADED', firingAlerts: 1 });
    expect(overview.services[0].latest.error_rate.value).toBe(42);
    const incident = (await org.owner.get('/api/v1/incidents/INC-1')).body;
    expect(incident).toMatchObject({ source: 'alert', severity: 'SEV2', title: 'Search: Error rate high' });

    await prisma.metricSample.deleteMany({ where: { organizationId: org.organizationId } });
    await send(0.2);
    expect(await evaluateAlerts(org.organizationId)).toMatchObject({ resolved: 1 });
    expect((await org.owner.get('/api/v1/monitoring/alerts?status=firing')).body.meta.total).toBe(0);
    const series = (await org.owner.get('/api/v1/monitoring/series?service=search&metric=error_rate')).body;
    expect(series.series[0].points.length).toBeGreaterThan(0);
    await org.owner.patch(`/api/v1/monitoring/alert-rules/${rule.id}`).send({ enabled: false }).expect(200);
    await org.owner.delete(`/api/v1/monitoring/alert-rules/${rule.id}`).expect(204);
  });
});

describe('deployment intelligence', () => {
  it('reports what a deployment replaced, what it shipped and what happened after it', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    await createService(other.owner, 'Checkout');
    const key = await createApiKey(org.owner, ['tools:read']);
    const ctx = (query: string) => api().get(`/api/v1/tools/deployment-context?${query}`).set('x-api-key', key);

    expect((await ctx('service=checkout')).body).toMatchObject({ deployment: null, service: 'checkout' });

    // The previous good version is nine days old: far outside any window an investigator would guess.
    const sha = 'c0ffee1234567890abcdef';
    const repo = await prisma.repository.create({ data: { organizationId: org.organizationId, fullName: 'acme/checkout', serviceId: service.id } });
    await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1.0.0', startedAt: minutesAgo(60 * 24 * 9) }).expect(201);
    await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1.1.0-broken', status: 'FAILED', startedAt: minutesAgo(60 * 24 * 2) }).expect(201);
    const current = (await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1.2.0', commitSha: sha, startedAt: minutesAgo(20) })).body;
    await prisma.commit.createMany({
      data: [
        { repositoryId: repo.id, sha, message: 'Lower DB pool size (#12)', authorLogin: 'dev1', committedAt: new Date(Date.now() - 5 * 3600_000), filesChanged: [{ filename: 'config/pool.yaml' }] },
        { repositoryId: repo.id, sha: 'bbbb222233334444', message: 'Unrelated copy change', authorLogin: 'dev2', committedAt: new Date(Date.now() - 30 * 3600_000) },
        { repositoryId: repo.id, sha: 'aaaa111122223333', message: 'Shipped long ago in v1.0.0', authorLogin: 'dev2', committedAt: new Date(Date.now() - 12 * 86_400_000) },
      ],
    });
    await prisma.pullRequest.create({ data: { repositoryId: repo.id, number: 12, title: 'Lower DB pool size', state: 'merged', mergeCommitSha: sha, labels: ['config'], openedAt: new Date(Date.now() - 6 * 3600_000), mergedAt: new Date(Date.now() - 5 * 3600_000) } });
    await org.owner.post('/api/v1/logs').send({
      service: 'checkout',
      logs: [
        { level: 'error', message: 'background noise', timestamp: minutesAgo(35) },
        ...Array.from({ length: 12 }, (_, i) => ({ level: 'error', message: `timeout acquiring connection ${i}`, timestamp: minutesAgo(15 - i) })),
        { level: 'info', message: 'not an error', timestamp: minutesAgo(10) },
      ],
    });
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing after deploy', serviceIds: [service.id], startedAt: minutesAgo(12) })).body;

    const body = (await ctx('service=checkout')).body;
    expect(body.deployment).toMatchObject({ id: current.id, version: 'v1.2.0' });
    expect(body).toMatchObject({ isLatest: true, alreadyRolledBack: false });
    // The failed release in between is skipped: the rollback target is the last one that worked.
    expect(body.previousSuccessful.version).toBe('v1.0.0');
    expect(body.rollbackTarget).toMatchObject({ deploymentId: current.id, fromVersion: 'v1.2.0', toVersion: 'v1.0.0' });
    // Everything merged since the previous good deployment, with the deployed commit first; nothing older.
    expect(body.changes.commits.map((c: { message: string }) => c.message)).toEqual(['Lower DB pool size (#12)', 'Unrelated copy change']);
    expect(body.changes.commits[0].files).toEqual(['config/pool.yaml']);
    expect(body.changes.pullRequests[0]).toMatchObject({ number: 12, labels: ['config'] });
    expect(body.errorLogs).toMatchObject({ before: 1, after: 12, windowMinutes: 20 });
    expect(body.errorLogs.afterPerMinute).toBeGreaterThan(body.errorLogs.beforePerMinute * 10);
    expect(body.incidentsAfter).toEqual([expect.objectContaining({ key: incident.key })]);
    expect(body.recentDeployments.map((d: { version: string }) => d.version)).toEqual(['v1.2.0', 'v1.1.0-broken', 'v1.0.0']);

    // A specific earlier deployment can be examined too, and a first deployment has no rollback target.
    const first = body.recentDeployments[2];
    const earliest = (await ctx(`service=checkout&deploymentId=${first.id}`)).body;
    expect(earliest).toMatchObject({ isLatest: false, previousSuccessful: null, rollbackTarget: null });
    expect(earliest.changes.note).toContain('no commit SHA');

    // Scoped to the caller's organisation, and read-only for viewers of the tool API only.
    const otherKey = await createApiKey(other.owner, ['tools:read']);
    expect((await api().get('/api/v1/tools/deployment-context?service=checkout').set('x-api-key', otherKey)).body.deployment).toBeNull();
    expect((await api().get(`/api/v1/tools/deployment-context?service=checkout&deploymentId=${current.id}`).set('x-api-key', otherKey)).body.deployment).toBeNull();
    expect((await ctx('service=missing')).status).toBe(404);
    expect((await ctx('')).status).toBe(400);
  });
});
