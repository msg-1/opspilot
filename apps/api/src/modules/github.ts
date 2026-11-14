import type { Prisma } from '@prisma/client';
import { type Request, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { type GhCommit, type GhPullRequest, type GithubAdapter, GithubError, MockGithubAdapter, RestGithubAdapter, mapPull } from '../integrations/github';
import { audit, writeAudit } from '../lib/audit';
import { decrypt, encrypt, hmacSha256Hex, safeEqual } from '../lib/crypto';
import { badRequest, notFound, unauthorized } from '../lib/errors';
import { paged, paginate, paginationQuery, param, timeParam } from '../lib/http';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission } from '../middleware/auth';
import { enqueue, registerProcessor } from '../queues';
import { findService } from './services';

const SYNC_LOOKBACK_DAYS = 30;

// Tests swap this to point the REST adapter at a local stub server.
export const githubConfig = { baseUrl: 'https://api.github.com' };

async function tokenFor(organizationId: string): Promise<{ token?: string; source: 'organization' | 'environment' | 'none' }> {
  const integration = await prisma.githubIntegration.findUnique({ where: { organizationId } });
  if (integration?.tokenEncrypted) return { token: decrypt(integration.tokenEncrypted), source: 'organization' };
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'environment' };
  return { source: 'none' };
}

async function adapterFor(organizationId: string, isMock: boolean): Promise<GithubAdapter> {
  if (isMock) return new MockGithubAdapter();
  return new RestGithubAdapter((await tokenFor(organizationId)).token, githubConfig.baseUrl);
}

// ───────────────────────── Persistence helpers ─────────────────────────

async function upsertCommits(repositoryId: string, commits: GhCommit[]) {
  for (const c of commits) {
    const data = { ...c, message: c.message.slice(0, 4000), filesChanged: (c.filesChanged ?? undefined) as Prisma.InputJsonValue | undefined };
    await prisma.commit.upsert({
      where: { repositoryId_sha: { repositoryId, sha: c.sha } },
      create: { repositoryId, ...data },
      // A push webhook may have stored the commit without stats; a later sync fills them in.
      update: { additions: data.additions ?? undefined, deletions: data.deletions ?? undefined, filesChanged: data.filesChanged },
    });
  }
}

async function upsertPulls(repositoryId: string, pulls: GhPullRequest[]) {
  for (const p of pulls) {
    await prisma.pullRequest.upsert({
      where: { repositoryId_number: { repositoryId, number: p.number } },
      create: { repositoryId, ...p },
      update: { title: p.title, body: p.body, state: p.state, mergeCommitSha: p.mergeCommitSha, labels: p.labels, mergedAt: p.mergedAt, closedAt: p.closedAt },
    });
  }
}

export async function syncRepositories(organizationId: string, repositoryId?: string) {
  const repos = await prisma.repository.findMany({ where: { organizationId, ...(repositoryId ? { id: repositoryId } : {}) } });
  const results: { repository: string; commits: number; pullRequests: number; error?: string }[] = [];
  for (const repo of repos) {
    try {
      const adapter = await adapterFor(organizationId, repo.isMock);
      const since = repo.lastSyncedAt ? new Date(repo.lastSyncedAt.getTime() - 3600_000) : new Date(Date.now() - SYNC_LOOKBACK_DAYS * 86_400_000);
      const [commits, pulls] = await Promise.all([adapter.listCommits(repo.fullName, since, 100), adapter.listPullRequests(repo.fullName, since, 100)]);
      await upsertCommits(repo.id, commits);
      await upsertPulls(repo.id, pulls);
      await prisma.repository.update({ where: { id: repo.id }, data: { lastSyncedAt: new Date() } });
      results.push({ repository: repo.fullName, commits: commits.length, pullRequests: pulls.length });
    } catch (err) {
      const message = err instanceof GithubError ? err.message : (err as Error).message;
      logger.warn({ err, repository: repo.fullName }, 'github sync failed');
      results.push({ repository: repo.fullName, commits: 0, pullRequests: 0, error: message });
    }
  }
  const failed = results.filter((r) => r.error);
  await prisma.githubIntegration.upsert({
    where: { organizationId },
    create: { organizationId, lastSyncAt: new Date(), lastSyncStatus: failed.length ? 'error' : 'ok', lastSyncError: failed.map((f) => `${f.repository}: ${f.error}`).join('; ') || null },
    update: { lastSyncAt: new Date(), lastSyncStatus: failed.length ? 'error' : 'ok', lastSyncError: failed.map((f) => `${f.repository}: ${f.error}`).join('; ').slice(0, 1000) || null },
  });
  return results;
}

registerProcessor('github-sync', async ({ organizationId, repositoryId }) => {
  await syncRepositories(organizationId, repositoryId);
});

/**
 * Asks GitHub whether what is configured works: the token (if there is one) and every
 * connected repository. Read-only. The result names repositories and GitHub's answer in our
 * own words; it never contains the token.
 */
export async function checkGithub(organizationId: string): Promise<{ ok: boolean; detail: string; accountLogin: string | null }> {
  const { token, source } = await tokenFor(organizationId);
  const adapter = new RestGithubAdapter(token, githubConfig.baseUrl);
  const say = (err: unknown) => (err instanceof GithubError ? err.message : 'GitHub could not be reached.');
  let accountLogin: string | null = null;
  if (token) {
    try {
      accountLogin = await adapter.whoAmI();
    } catch (err) {
      return { ok: false, detail: say(err), accountLogin: null };
    }
  }
  const repos = await prisma.repository.findMany({ where: { organizationId, isMock: false }, select: { fullName: true }, orderBy: { fullName: 'asc' }, take: 10 });
  const failures: string[] = [];
  for (const repo of repos) {
    try {
      await adapter.getRepository(repo.fullName);
    } catch (err) {
      failures.push(`${repo.fullName}: ${say(err)}`);
    }
  }
  const who = token ? `Authenticated as ${accountLogin ?? 'an unnamed account'} (token from ${source === 'environment' ? 'the installation' : 'this organisation'}).` : 'No token: public repositories only, at GitHub\'s unauthenticated rate limit.';
  if (failures.length) return { ok: false, detail: `${who} ${failures.length} of ${repos.length} repositories could not be read. ${failures.join(' ')}`, accountLogin };
  return { ok: true, detail: `${who} ${repos.length ? `${repos.length} of ${repos.length} connected repositories can be read.` : 'No repository is connected yet.'}`, accountLogin };
}

// ───────────────────────── Routes ─────────────────────────

export const githubRouter = Router();

async function integrationView(organizationId: string) {
  const [integration, { source }, repoCount] = await Promise.all([
    prisma.githubIntegration.findUnique({ where: { organizationId } }),
    tokenFor(organizationId),
    prisma.repository.count({ where: { organizationId } }),
  ]);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } });
  return {
    // token: authenticated REST API · public: unauthenticated REST API (public repos, 60 req/h)
    mode: source === 'none' ? 'public' : 'token',
    tokenSource: source,
    accountLogin: integration?.accountLogin ?? null,
    webhookSecretSet: !!integration?.webhookSecretEncrypted || !!env.GITHUB_WEBHOOK_SECRET,
    webhookPath: `/api/v1/webhooks/github/${org.slug}`,
    lastSyncAt: integration?.lastSyncAt ?? null,
    lastSyncStatus: integration?.lastSyncStatus ?? null,
    lastSyncError: integration?.lastSyncError ?? null,
    repositoryCount: repoCount,
  };
}

githubRouter.get('/integration', requirePermission('read'), async (req, res) => {
  res.json(await integrationView(authOf(req).organizationId));
});

githubRouter.put('/integration', requirePermission('integration:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z
    .object({ token: z.string().trim().min(20).max(400).nullable().optional(), webhookSecret: z.string().trim().min(16).max(200).nullable().optional() })
    .parse(req.body);
  const data: Prisma.GithubIntegrationUncheckedUpdateInput = {};
  if (body.token !== undefined) {
    if (body.token) {
      // Validate before storing so a typo is reported immediately, not at the next sync.
      let login: string | null;
      try {
        login = await new RestGithubAdapter(body.token, githubConfig.baseUrl).whoAmI();
      } catch (err) {
        throw badRequest(err instanceof GithubError ? err.message : 'Could not reach GitHub to validate the token');
      }
      Object.assign(data, { tokenEncrypted: encrypt(body.token), accountLogin: login, mode: 'token' });
    } else {
      Object.assign(data, { tokenEncrypted: null, accountLogin: null, mode: 'mock' });
    }
  }
  if (body.webhookSecret !== undefined) data.webhookSecretEncrypted = body.webhookSecret ? encrypt(body.webhookSecret) : null;
  await prisma.githubIntegration.upsert({
    where: { organizationId },
    create: { ...(data as object), organizationId } as Prisma.GithubIntegrationUncheckedCreateInput,
    update: data,
  });
  await audit(req, 'github.integration_update', 'github_integration', organizationId, {
    token: body.token === undefined ? 'unchanged' : body.token ? 'set' : 'removed',
    webhookSecret: body.webhookSecret === undefined ? 'unchanged' : body.webhookSecret ? 'set' : 'removed',
  });
  res.json(await integrationView(organizationId));
});

githubRouter.get('/repositories', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const repos = await prisma.repository.findMany({
    where: { organizationId },
    orderBy: { fullName: 'asc' },
    include: { service: { select: { id: true, name: true, slug: true } }, _count: { select: { commits: true, pullRequests: true } } },
  });
  res.json({ data: repos.map(({ _count, ...r }) => ({ ...r, commitCount: _count.commits, pullRequestCount: _count.pullRequests })) });
});

githubRouter.post('/repositories', requirePermission('integration:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z
    .object({
      fullName: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'Use the form owner/repository'),
      service: z.string().nullable().optional(),
      // Sample repositories use the mock adapter and never contact GitHub.
      sample: z.boolean().default(false),
    })
    .parse(req.body);
  const service = body.service ? await findService(organizationId, body.service) : null;
  if (body.service && !service) throw badRequest('Service does not exist');
  const adapter = await adapterFor(organizationId, body.sample);
  let info;
  try {
    info = await adapter.getRepository(body.fullName);
  } catch (err) {
    throw badRequest(err instanceof GithubError ? err.message : 'Could not reach GitHub');
  }
  const repo = await prisma.repository.create({
    data: { organizationId, fullName: info.fullName, defaultBranch: info.defaultBranch, url: body.sample ? null : info.url, serviceId: service?.id ?? null, isMock: body.sample },
  });
  await audit(req, 'github.repository_add', 'repository', repo.id, { fullName: repo.fullName, sample: body.sample });
  await enqueue('github-sync', { organizationId, repositoryId: repo.id });
  res.status(201).json(repo);
});

githubRouter.patch('/repositories/:id', requirePermission('integration:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z.object({ service: z.string().nullable() }).parse(req.body);
  const existing = await prisma.repository.findFirst({ where: { id: param(req.params.id), organizationId } });
  if (!existing) throw notFound('Repository');
  const service = body.service ? await findService(organizationId, body.service) : null;
  if (body.service && !service) throw badRequest('Service does not exist');
  const repo = await prisma.repository.update({ where: { id: existing.id }, data: { serviceId: service?.id ?? null } });
  await audit(req, 'github.repository_link', 'repository', repo.id, { service: service?.slug ?? null });
  res.json(repo);
});

githubRouter.delete('/repositories/:id', requirePermission('integration:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.repository.deleteMany({ where: { id: param(req.params.id), organizationId } });
  if (!result.count) throw notFound('Repository');
  await audit(req, 'github.repository_remove', 'repository', param(req.params.id));
  res.status(204).end();
});

githubRouter.post('/sync', requirePermission('github:sync'), async (req, res) => {
  const { organizationId } = authOf(req);
  const { repositoryId } = z.object({ repositoryId: z.string().optional() }).parse(req.body ?? {});
  await enqueue('github-sync', { organizationId, repositoryId });
  await audit(req, 'github.sync', 'github_integration', organizationId, { repositoryId: repositoryId ?? 'all' });
  res.status(202).json({ queued: true });
});

const changeQuery = paginationQuery.extend({
  repository: z.string().optional(),
  service: z.string().optional(),
  q: z.string().trim().optional(),
  from: timeParam.optional(),
  to: timeParam.optional(),
});

async function repoScope(organizationId: string, q: { repository?: string; service?: string }): Promise<Prisma.RepositoryWhereInput> {
  const service = q.service ? await findService(organizationId, q.service) : null;
  return { organizationId, ...(q.repository ? { OR: [{ id: q.repository }, { fullName: q.repository }] } : {}), ...(q.service ? { serviceId: service?.id ?? '__none__' } : {}) };
}

githubRouter.get('/commits', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = changeQuery.parse(req.query);
  const where: Prisma.CommitWhereInput = {
    repository: await repoScope(organizationId, q),
    ...(q.q ? { OR: [{ message: { contains: q.q, mode: 'insensitive' } }, { sha: { startsWith: q.q } }, { authorLogin: { contains: q.q, mode: 'insensitive' } }] } : {}),
    ...(q.from || q.to ? { committedAt: { gte: q.from, lte: q.to } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.commit.findMany({ where, orderBy: { committedAt: 'desc' }, ...paginate(q), include: { repository: { select: { id: true, fullName: true, isMock: true, service: { select: { id: true, name: true, slug: true } } } } } }),
    prisma.commit.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

githubRouter.get('/pull-requests', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = changeQuery.extend({ state: z.enum(['open', 'closed', 'merged']).optional() }).parse(req.query);
  const where: Prisma.PullRequestWhereInput = {
    repository: await repoScope(organizationId, q),
    ...(q.state ? { state: q.state } : {}),
    ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { authorLogin: { contains: q.q, mode: 'insensitive' } }] } : {}),
    ...(q.from || q.to ? { openedAt: { gte: q.from, lte: q.to } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.pullRequest.findMany({ where, orderBy: { openedAt: 'desc' }, ...paginate(q), include: { repository: { select: { id: true, fullName: true, isMock: true, service: { select: { id: true, name: true, slug: true } } } } } }),
    prisma.pullRequest.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

// ───────────────────────── Webhook (unauthenticated; HMAC-verified) ─────────────────────────

export const githubWebhookRouter = Router();

/* eslint-disable @typescript-eslint/no-explicit-any */
githubWebhookRouter.post('/:orgSlug', async (req: Request & { rawBody?: Buffer }, res) => {
  const org = await prisma.organization.findUnique({ where: { slug: param(req.params.orgSlug) }, include: { githubIntegration: true } });
  if (!org) throw notFound('Organisation');
  const secret = org.githubIntegration?.webhookSecretEncrypted ? decrypt(org.githubIntegration.webhookSecretEncrypted) : env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw badRequest('No webhook secret is configured for this organisation');
  const signature = req.header('x-hub-signature-256') ?? '';
  const expected = `sha256=${hmacSha256Hex(secret, req.rawBody ?? Buffer.from(''))}`;
  if (!safeEqual(signature, expected)) throw unauthorized('Invalid webhook signature');

  const event = req.header('x-github-event');
  const payload = req.body as any;
  const fullName: string | undefined = payload?.repository?.full_name;
  const repo = fullName ? await prisma.repository.findUnique({ where: { organizationId_fullName: { organizationId: org.id, fullName } } }) : null;
  if (event === 'ping') {
    res.json({ ok: true, message: 'pong' });
    return;
  }
  if (!repo || repo.isMock) {
    res.status(202).json({ ok: true, ignored: 'repository is not connected' });
    return;
  }
  let handled = 0;
  if (event === 'push' && payload.ref === `refs/heads/${repo.defaultBranch}`) {
    const commits: GhCommit[] = (payload.commits ?? []).map((c: any) => ({
      sha: c.id,
      message: c.message ?? '',
      authorName: c.author?.name ?? null,
      authorLogin: c.author?.username ?? null,
      committedAt: new Date(c.timestamp),
      url: c.url ?? null,
      additions: null,
      deletions: null,
      filesChanged: [...(c.added ?? []).map((f: string) => ({ filename: f, additions: 0, deletions: 0, status: 'added' })), ...(c.modified ?? []).map((f: string) => ({ filename: f, additions: 0, deletions: 0, status: 'modified' })), ...(c.removed ?? []).map((f: string) => ({ filename: f, additions: 0, deletions: 0, status: 'removed' }))],
    }));
    await upsertCommits(repo.id, commits);
    handled = commits.length;
  } else if (event === 'pull_request' && payload.pull_request) {
    await upsertPulls(repo.id, [mapPull(payload.pull_request)]);
    handled = 1;
  }
  await writeAudit({ organizationId: org.id, actorType: 'system', actorLabel: 'GitHub webhook', action: 'github.webhook', resourceType: 'repository', resourceId: repo.id, metadata: { event, handled } });
  res.status(202).json({ ok: true, handled });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
