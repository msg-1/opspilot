import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

export const app = createApp();
export const PASSWORD = 'Sup3r-secret-pw';
export type Agent = ReturnType<typeof request.agent>;

export interface TestOrg {
  owner: Agent;
  organizationId: string;
  slug: string;
  ownerId: string;
  /** Adds a signed-in member with the given role and returns their agent. */
  member: (role: Role, name?: string) => Promise<{ agent: Agent; userId: string; name: string }>;
}

export const unique = (prefix = 'x') => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Registers a fresh organisation. Every test uses its own, so tests never see each other's data. */
export async function createOrg(name = 'Test Org'): Promise<TestOrg> {
  const owner = request.agent(app);
  const res = await owner.post('/api/v1/auth/register').send({ email: `${unique('owner')}@example.com`, password: PASSWORD, name: 'Olivia Owner', organizationName: `${name} ${unique()}` });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const organizationId: string = res.body.organization.id;
  return {
    owner,
    organizationId,
    slug: res.body.organization.slug,
    ownerId: res.body.user.id,
    member: async (role, name = `${role[0]}${role.slice(1).toLowerCase()} ${unique('user')}`) => {
      const invite = await owner.post('/api/v1/members/invitations').send({ email: `${unique('m')}@example.com`, role });
      if (invite.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invite.body)}`);
      const agent = request.agent(app);
      const accepted = await agent.post('/api/v1/auth/accept-invitation').send({ token: invite.body.token, name, password: PASSWORD });
      if (accepted.status !== 201) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
      return { agent, userId: accepted.body.user.id, name };
    },
  };
}

export async function createService(agent: Agent, name = unique('svc')) {
  const res = await agent.post('/api/v1/services').send({ name, tier: 'TIER1' });
  if (res.status !== 201) throw new Error(`service failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; slug: string; name: string };
}

export async function createApiKey(agent: Agent, scopes: string[]) {
  const res = await agent.post('/api/v1/api-keys').send({ name: unique('key'), scopes });
  if (res.status !== 201) throw new Error(`api key failed: ${JSON.stringify(res.body)}`);
  return res.body.secret as string;
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
export const api = () => request(app);
export { prisma };
