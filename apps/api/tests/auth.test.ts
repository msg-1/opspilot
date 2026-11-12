import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PASSWORD, api, app, createApiKey, createOrg, createService, prisma, unique } from './helpers';

describe('authentication', () => {
  it('registers, returns the session, and rejects weak or duplicate input', async () => {
    const email = `${unique('a')}@example.com`;
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/register').send({ email, password: PASSWORD, name: 'Ada', organizationName: 'Ada Corp' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ user: { email, name: 'Ada' }, role: 'OWNER' });
    expect(res.body.permissions).toContain('org:manage');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).not.toContain(PASSWORD);

    expect((await agent.get('/api/v1/auth/me')).body.organization.name).toBe('Ada Corp');
    expect((await api().post('/api/v1/auth/register').send({ email, password: PASSWORD, name: 'Ada', organizationName: 'Other' })).status).toBe(409);
    const weak = await api().post('/api/v1/auth/register').send({ email: 'nope', password: 'short', name: '', organizationName: 'x' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('validation_error');
    expect(weak.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password', 'name']));
  });

  it('logs in with correct credentials only, without revealing which part was wrong', async () => {
    const org = await createOrg();
    const me = await org.owner.get('/api/v1/auth/me');
    const email = me.body.user.email;
    const ok = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(ok.status).toBe(200);
    const wrongPassword = await api().post('/api/v1/auth/login').send({ email, password: 'Wrong-password-1' });
    const wrongEmail = await api().post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expect([wrongPassword.status, wrongEmail.status]).toEqual([401, 401]);
    expect(wrongPassword.body).toEqual(wrongEmail.body);
  });

  it('rotates refresh tokens and revokes the whole session family when one is replayed', async () => {
    const org = await createOrg();
    const email = (await org.owner.get('/api/v1/auth/me')).body.user.email;
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const refreshCookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('op_refresh='))!.split(';')[0]!;
    const first = await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookie);
    expect(first.status).toBe(200);
    const rotated = (first.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('op_refresh='))!.split(';')[0]!;
    expect(rotated).not.toBe(refreshCookie);
    // Replaying the old token is treated as theft.
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookie)).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', rotated)).status).toBe(401);
  });

  it('logs out and rejects unauthenticated or forged requests', async () => {
    const org = await createOrg();
    expect((await org.owner.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await org.owner.get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/incidents')).status).toBe(401);
    expect((await api().get('/api/v1/incidents').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
  });
});

describe('authorisation and tenancy', () => {
  it('enforces role permissions', async () => {
    const org = await createOrg();
    const viewer = await org.member('VIEWER');
    const engineer = await org.member('ENGINEER');
    expect((await viewer.agent.get('/api/v1/incidents')).status).toBe(200);
    expect((await viewer.agent.post('/api/v1/incidents').send({ title: 'Viewer cannot open this' })).status).toBe(403);
    expect((await viewer.agent.post('/api/v1/investigations').send({ question: 'why is it down today?' })).status).toBe(403);
    expect((await engineer.agent.post('/api/v1/incidents').send({ title: 'Engineer can open this' })).status).toBe(201);
    expect((await engineer.agent.get('/api/v1/audit-logs')).status).toBe(403);
    expect((await engineer.agent.post('/api/v1/api-keys').send({ name: 'nope', scopes: ['ingest:logs'] })).status).toBe(403);
    expect((await engineer.agent.patch('/api/v1/settings').send({ allowSelfApproval: true })).status).toBe(403);
    expect((await org.owner.get('/api/v1/audit-logs')).status).toBe(200);
  });

  it('isolates organisations from each other', async () => {
    const [a, b] = await Promise.all([createOrg('A'), createOrg('B')]);
    const service = await createService(a.owner);
    const incident = (await a.owner.post('/api/v1/incidents').send({ title: 'Secret incident of A', serviceIds: [service.id] })).body;
    expect((await b.owner.get(`/api/v1/incidents/${incident.id}`)).status).toBe(404);
    expect((await b.owner.get(`/api/v1/services/${service.id}`)).status).toBe(404);
    expect((await b.owner.patch(`/api/v1/incidents/${incident.id}`).send({ title: 'hijacked title' })).status).toBe(404);
    expect((await b.owner.get('/api/v1/incidents')).body.data).toHaveLength(0);
    // Cross-tenant references are rejected, not silently linked.
    expect((await b.owner.post('/api/v1/incidents').send({ title: 'Uses a foreign service', serviceIds: [service.id] })).status).toBe(400);
    expect((await b.owner.post('/api/v1/incidents').send({ title: 'Uses a foreign user', assigneeId: a.ownerId })).status).toBe(400);
  });

  it('limits API keys to their scopes and never stores the secret', async () => {
    const org = await createOrg();
    const service = await createService(org.owner);
    const key = await createApiKey(org.owner, ['ingest:logs']);
    expect(key).toMatch(/^opk_/);
    const stored = await prisma.apiKey.findFirstOrThrow({ where: { organizationId: org.organizationId } });
    expect(stored.keyHash).not.toContain(key);
    const ingest = await api().post('/api/v1/logs').set('x-api-key', key).send({ service: service.slug, logs: [{ message: 'hello', level: 'info' }] });
    expect(ingest.status).toBe(202);
    expect((await api().get('/api/v1/incidents').set('x-api-key', key)).status).toBe(403);
    expect((await api().post('/api/v1/deployments').set('x-api-key', key).send({ service: service.slug, version: 'v1' })).status).toBe(403);
    expect((await api().post('/api/v1/api-keys').set('x-api-key', key).send({ name: 'escalate', scopes: ['tools:read'] })).status).toBe(403);
    const keys = await org.owner.get('/api/v1/api-keys');
    await org.owner.delete(`/api/v1/api-keys/${keys.body.data[0].id}`).expect(204);
    expect((await api().post('/api/v1/logs').set('x-api-key', key).send({ logs: [{ message: 'x' }] })).status).toBe(401);
  });

  it('manages members: role limits, last owner protection, immediate removal', async () => {
    const org = await createOrg();
    const admin = await org.member('ADMIN');
    const engineer = await org.member('ENGINEER');
    const members = (await org.owner.get('/api/v1/members')).body.data as { id: string; role: string; user: { id: string } }[];
    const ownerMembership = members.find((m) => m.role === 'OWNER')!;
    const engineerMembership = members.find((m) => m.user.id === engineer.userId)!;
    expect((await admin.agent.post('/api/v1/members/invitations').send({ email: 'boss@example.com', role: 'OWNER' })).status).toBe(403);
    expect((await admin.agent.patch(`/api/v1/members/${ownerMembership.id}`).send({ role: 'VIEWER' })).status).toBe(403);
    expect((await org.owner.patch(`/api/v1/members/${ownerMembership.id}`).send({ role: 'ADMIN' })).status).toBe(400);
    expect((await engineer.agent.get('/api/v1/services')).status).toBe(200);
    await org.owner.delete(`/api/v1/members/${engineerMembership.id}`).expect(204);
    // The removed member's existing access token stops working at once.
    expect((await engineer.agent.get('/api/v1/services')).status).toBe(401);
    const actions = (await org.owner.get('/api/v1/audit-logs?action=member')).body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['member.invite', 'member.join', 'member.remove']));
  });
});
