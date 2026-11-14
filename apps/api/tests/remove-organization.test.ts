import { describe, expect, it } from 'vitest';
import { organizationFootprint, removeOrganization } from '../src/lib/removeOrganization';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

// Removing a trial organisation: everything of it goes, nothing of anyone else's does.
describe('removing an organisation', () => {
  it('removes that organisation completely and leaves every other one exactly as it was', async () => {
    const [trial, other] = [await createOrg('Trial'), await createOrg('Other')];
    for (const org of [trial, other]) {
      await createService(org.owner, 'Checkout');
      const key = await createApiKey(org.owner, ['ingest:logs']);
      await api().post('/api/v1/logs').set('x-api-key', key).send({ service: 'checkout', logs: [{ level: 'error', message: 'boom' }] }).expect(202);
      await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing' }).expect(201);
      await org.member('ENGINEER');
    }
    const otherBefore = await organizationFootprint(other.slug);

    const footprint = (await organizationFootprint(trial.slug))!;
    expect(footprint.counts).toMatchObject({ membership: 2, service: 1, incident: 1, logEntry: 1, apiKey: 1 });
    expect(footprint.soleMembers).toHaveLength(2);
    // Looking changes nothing, and a wrong confirmation removes nothing.
    await expect(removeOrganization(trial.slug, { confirm: other.slug })).rejects.toThrow('Not removed');
    await expect(removeOrganization('no-such-organisation', { confirm: 'no-such-organisation' })).rejects.toThrow('There is no organisation');
    expect(await organizationFootprint(trial.slug)).toEqual(footprint);

    const result = await removeOrganization(trial.slug, { confirm: trial.slug });
    expect(result).toMatchObject({ removedUsers: 0, keptUsers: 2 });
    expect(await organizationFootprint(trial.slug)).toBeNull();
    for (const table of ['service', 'incident', 'logEntry', 'apiKey', 'membership', 'auditLog', 'integrationState', 'refreshToken'] as const) {
      expect(await (prisma[table] as unknown as { count: (a: object) => Promise<number> }).count({ where: { organizationId: trial.organizationId } })).toBe(0);
    }
    // The other organisation: same rows, and its people can still work.
    expect(await organizationFootprint(other.slug)).toEqual(otherBefore);
    expect((await other.owner.get('/api/v1/incidents').expect(200)).body.data).toHaveLength(1);
    // The removed organisation's session is of no use any more; the account still exists.
    expect((await trial.owner.get('/api/v1/incidents')).status).toBe(401);
    expect(await prisma.user.count({ where: { id: trial.ownerId } })).toBe(1);
  });

  it('deletes accounts only on request, and only those that belong to nothing else', async () => {
    const [trial, other] = [await createOrg('Trial'), await createOrg('Other')];
    const solo = await trial.member('ENGINEER');
    // Someone who belongs to both: invited to the other organisation with the same account.
    const shared = await trial.member('ENGINEER');
    await prisma.membership.create({ data: { userId: shared.userId, organizationId: other.organizationId, role: 'VIEWER' } });

    const result = await removeOrganization(trial.slug, { confirm: trial.slug, deleteSoleMembers: true });
    expect(result).toMatchObject({ removedUsers: 2, keptUsers: 1 }); // the owner and the solo engineer
    expect(await prisma.user.count({ where: { id: { in: [trial.ownerId, solo.userId] } } })).toBe(0);
    expect(await prisma.user.count({ where: { id: shared.userId } })).toBe(1);
    expect(await prisma.membership.count({ where: { userId: shared.userId } })).toBe(1);
    expect(await prisma.user.count({ where: { id: other.ownerId } })).toBe(1);
  });
});
