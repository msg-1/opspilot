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
    const [staleRunning, freshRunning, staleQueued, freshQueued] = await Promise.all([mk('RUNNING', ago(45), ago(46)), mk('RUNNING', ago(2), ago(3)), mk('QUEUED', null, ago(90)), mk('QUEUED', null, ago(5))]);
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
  });
});
