import { describe, expect, it } from 'vitest';
import { PASSWORD, api, createOrg } from './helpers';

describe('sign-in throttling', () => {
  it('locks an account after repeated failures even when the client forges its address', async () => {
    const org = await createOrg();
    const email = (await org.owner.get('/api/v1/auth/me')).body.user.email;
    const attempt = (i: number, password = 'Wrong-password-12') => api().post('/api/v1/auth/login').set('X-Forwarded-For', `203.0.113.${i}`).send({ email, password });
    const codes: number[] = [];
    for (let i = 1; i <= 12; i++) codes.push((await attempt(i)).status);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual([429, 429]);
    // The lock is on the account: the right password does not get through either, and a
    // different capitalisation of the address is the same account.
    expect((await attempt(99, PASSWORD)).status).toBe(429);
    expect((await api().post('/api/v1/auth/login').send({ email: email.toUpperCase(), password: PASSWORD })).status).toBe(429);
  });

  it('does not count successful sign-ins against the account', async () => {
    const org = await createOrg();
    const email = (await org.owner.get('/api/v1/auth/me')).body.user.email;
    for (let i = 0; i < 15; i++) expect((await api().post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  });

  it('ignores X-Forwarded-For unless proxy trust is configured', async () => {
    const org = await createOrg();
    await org.owner.post('/api/v1/incidents').set('X-Forwarded-For', '198.51.100.77').send({ title: 'Address spoofing probe' }).expect(201);
    const entry = (await org.owner.get('/api/v1/audit-logs?action=incident.create')).body.data[0];
    expect(entry.ip).not.toBe('198.51.100.77');
  });
});

describe('input validation', () => {
  it('answers 400, not 500, for filter values outside the allowed set', async () => {
    const org = await createOrg();
    for (const path of ['/incidents?status=BOGUS', '/incidents?severity=SEV9', '/services?tier=X', '/services?health=FINE', '/deployments?status=BOGUS', '/remediations?status=NOPE', '/investigations?status=NOPE', '/tools/incidents?status=NOPE']) {
      const res = await org.owner.get(`/api/v1${path}`);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    expect((await org.owner.get('/api/v1/incidents?status=OPEN,RESOLVED')).status).toBe(200);
  });

  it('accepts only http and https links', async () => {
    const org = await createOrg();
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
      expect((await org.owner.post('/api/v1/services').send({ name: `svc ${bad.length}`, repoUrl: bad })).status, bad).toBe(400);
      expect((await org.owner.post('/api/v1/knowledge/documents').send({ title: 'A document', content: 'text', sourceUrl: bad })).status, bad).toBe(400);
    }
    expect((await org.owner.post('/api/v1/services').send({ name: 'Linked', repoUrl: 'https://github.com/acme/linked' })).status).toBe(201);
  });

  it('neutralises spreadsheet formulas in CSV exports', async () => {
    const org = await createOrg();
    await org.owner.post('/api/v1/incidents').send({ title: '=HYPERLINK("http://evil.example","click")' }).expect(201);
    await org.owner.post('/api/v1/incidents').send({ title: '@SUM(1+1) outage' }).expect(201);
    const csv = (await org.owner.get('/api/v1/analytics/incidents.csv?from=1d')).text;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(csv).toContain(`"'@SUM(1+1) outage"`);
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });
});

describe('recovery of stranded work', () => {
  it('fails interrupted investigations and executions honestly, and leaves fresh ones alone', async () => {
    const { reapStranded } = await import('../src/modules/system');
    const { prisma } = await import('./helpers');
    const org = await createOrg();
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Stranded work incident' })).body;
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const mk = (status: 'RUNNING' | 'QUEUED', startedAt: Date | null, createdAt: Date) => prisma.investigation.create({ data: { organizationId: org.organizationId, question: 'why did it stop?', status, startedAt, createdAt } });
    const [staleRunning, freshRunning, staleQueued, freshQueued] = await Promise.all([mk('RUNNING', ago(45), ago(46)), mk('RUNNING', ago(2), ago(3)), mk('QUEUED', null, ago(90)), mk('QUEUED', null, ago(1))]);
    const action = await prisma.remediationAction.create({ data: { organizationId: org.organizationId, incidentId: incident.id, type: 'restart_service', title: 'Restart checkout', description: 'Rolling restart', status: 'EXECUTING' } });
    await prisma.$executeRaw`UPDATE "RemediationAction" SET "updatedAt" = ${ago(30)} WHERE "id" = ${action.id}`;

    await reapStranded();

    const status = async (id: string) => (await prisma.investigation.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(staleRunning.id), await status(freshRunning.id), await status(staleQueued.id), await status(freshQueued.id)]).toEqual(['FAILED', 'RUNNING', 'FAILED', 'QUEUED']);
    const detail = (await org.owner.get(`/api/v1/investigations/${staleRunning.id}`)).body;
    expect(detail.error).toContain('worker stopped');
    expect(detail.steps.at(-1)).toMatchObject({ type: 'error', title: 'Investigation interrupted' });

    const reaped = (await org.owner.get(`/api/v1/remediations/${action.id}`)).body;
    expect(reaped).toMatchObject({ status: 'FAILED', executionResult: { mode: 'unknown', success: false } });
    expect(reaped.executionResult.summary).toContain('outcome is unknown');
    // A failed action can be retried by a person; nothing was re-executed automatically.
    const timeline = (await org.owner.get(`/api/v1/incidents/${incident.id}`)).body.timeline.map((e: { message: string }) => e.message);
    expect(timeline.some((m: string) => m.startsWith('Remediation outcome unknown'))).toBe(true);
    expect((await reapStranded())).toMatchObject({ remediations: 0 });
    // Nothing is left behind in a state a later sweep would act on.
    await prisma.investigation.deleteMany({ where: { id: { in: [freshRunning.id, freshQueued.id] } } });
  });
});

describe('session and request integrity', () => {
  it('invalidates access tokens the moment the session ends', async () => {
    const org = await createOrg();
    const email = (await org.owner.get('/api/v1/auth/me')).body.user.email;
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const bearer = { Authorization: `Bearer ${login.body.accessToken}` };
    const cookies = login.headers['set-cookie'] as unknown as string[];
    expect((await api().get('/api/v1/auth/me').set(bearer)).status).toBe(200);
    await api().post('/api/v1/auth/logout').set('Cookie', cookies.map((c) => c.split(';')[0]!)).expect(204);
    expect((await api().get('/api/v1/auth/me').set(bearer)).status).toBe(401);

    // Changing the password ends every other session but keeps this device signed in.
    const other = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    await org.owner.patch('/api/v1/auth/profile').send({ currentPassword: PASSWORD, newPassword: 'A-new-passw0rd-here' }).expect(200);
    expect((await api().get('/api/v1/auth/me').set({ Authorization: `Bearer ${other.body.accessToken}` })).status).toBe(401);
    expect((await org.owner.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('refuses cookie-authenticated writes from another origin', async () => {
    const org = await createOrg();
    const create = (origin?: string) => {
      const req = org.owner.post('/api/v1/incidents');
      return (origin ? req.set('Origin', origin) : req).send({ title: 'Cross-site request probe' });
    };
    expect((await create('https://evil.example')).status).toBe(403);
    expect((await create('http://localhost:3000')).status).toBe(201);
    expect((await create()).status).toBe(201); // non-browser clients send no Origin
    // Reads are unaffected, and so are requests that authenticate with a key instead of the cookie.
    expect((await org.owner.get('/api/v1/incidents').set('Origin', 'https://evil.example')).status).toBe(200);
    const { createApiKey, createService } = await import('./helpers');
    await createService(org.owner, 'Origin Probe');
    const key = await createApiKey(org.owner, ['ingest:logs']);
    expect((await api().post('/api/v1/logs').set('x-api-key', key).set('Origin', 'https://ci.example').send({ service: 'origin-probe', logs: [{ message: 'x' }] })).status).toBe(202);
  });

  it('audits failed sign-ins against real accounts', async () => {
    const org = await createOrg();
    const email = (await org.owner.get('/api/v1/auth/me')).body.user.email;
    await api().post('/api/v1/auth/login').send({ email, password: 'Wrong-password-12' }).expect(401);
    const entries = (await org.owner.get('/api/v1/audit-logs?action=auth.login_failed')).body.data;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'auth.login_failed', resourceType: 'user' });
  });

  it('answers 503 with Retry-After when the database is unreachable', async () => {
    const { Prisma } = await import('@prisma/client');
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { errorHandler } = await import('../src/middleware/error');
    const probe = express();
    probe.get('/down', () => {
      throw new Prisma.PrismaClientInitializationError("Can't reach database server", '6.19.3', 'P1001');
    });
    probe.get('/lost', () => {
      throw new Prisma.PrismaClientKnownRequestError('Server has closed the connection', { code: 'P1017', clientVersion: '6.19.3' });
    });
    probe.use(errorHandler);
    for (const path of ['/down', '/lost']) {
      const res = await request(probe).get(path);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.error.code).toBe('service_unavailable');
      expect(JSON.stringify(res.body)).not.toContain('database server');
    }
  });
});

describe('remediation risk floor', () => {
  it('does not let the proposer understate the risk of a production change', async () => {
    const { createService } = await import('./helpers');
    const org = await createOrg();
    const tier1 = await createService(org.owner, 'Critical Path');
    const propose = (body: Record<string, unknown>) => org.owner.post('/api/v1/remediations').send({ title: 'Proposed action', description: 'Do the thing carefully', risk: 'LOW', ...body });
    expect((await propose({ type: 'rollback_deployment' })).body.risk).toBe('MEDIUM');
    expect((await propose({ type: 'config_change' })).body.risk).toBe('MEDIUM');
    expect((await propose({ type: 'restart_service', serviceId: tier1.id })).body.risk).toBe('MEDIUM');
    // A manual step is judged by what it does: "Do the thing" could be anything, so it counts as a change.
    expect((await propose({ type: 'manual' })).body).toMatchObject({ risk: 'MEDIUM', effect: 'state_changing' });
    expect((await propose({ type: 'manual', title: 'Check the error dashboard', description: 'Compare the error rate with yesterday.' })).body).toMatchObject({ risk: 'LOW', effect: 'read_only', requiredApprovals: 0 });
    expect((await propose({ type: 'run_runbook', title: 'Flush the order cache', description: 'Purge every order key.' })).body).toMatchObject({ risk: 'MEDIUM', effect: 'state_changing' });
    expect((await propose({ type: 'rollback_deployment', risk: 'HIGH' })).body).toMatchObject({ risk: 'HIGH', requiredApprovals: 2 });
  });
});
