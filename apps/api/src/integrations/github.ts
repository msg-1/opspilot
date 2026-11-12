import { createHash } from 'node:crypto';

/**
 * GitHub access goes through this adapter interface. Two implementations exist:
 *  - RestGithubAdapter: the real GitHub REST API (token optional; without one only public
 *    repositories work and GitHub's unauthenticated rate limit of 60 requests/hour applies).
 *  - MockGithubAdapter: deterministic sample data for repositories explicitly created as
 *    "sample" repositories. Its output is always flagged isMock and labelled in the UI.
 */

export interface GhCommit {
  sha: string;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  committedAt: Date;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  filesChanged: { filename: string; additions: number; deletions: number; status: string }[] | null;
}

export interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  authorLogin: string | null;
  url: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  mergeCommitSha: string | null;
  labels: string[];
  openedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
}

export interface GithubAdapter {
  readonly kind: 'rest' | 'mock';
  /** Returns the authenticated login, or null when running unauthenticated. */
  whoAmI(): Promise<string | null>;
  getRepository(fullName: string): Promise<{ fullName: string; defaultBranch: string; url: string; private: boolean }>;
  listCommits(fullName: string, since: Date, limit: number): Promise<GhCommit[]>;
  listPullRequests(fullName: string, since: Date, limit: number): Promise<GhPullRequest[]>;
}

export class GithubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class RestGithubAdapter implements GithubAdapter {
  readonly kind = 'rest' as const;
  constructor(
    private readonly token?: string,
    private readonly baseUrl = 'https://api.github.com',
  ) {}

  private async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'opspilot',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        throw new GithubError('GitHub rate limit exceeded. Add a personal access token in Settings → GitHub to raise the limit.', res.status);
      }
      if (res.status === 401) throw new GithubError('GitHub rejected the token (401). Check that it is valid and not expired.', 401);
      if (res.status === 404) throw new GithubError('Repository not found, or the token cannot access it.', 404);
      throw new GithubError(`GitHub API error ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  async whoAmI() {
    if (!this.token) return null;
    return (await this.get('/user')).login as string;
  }

  async getRepository(fullName: string) {
    const r = await this.get(`/repos/${fullName}`);
    return { fullName: r.full_name as string, defaultBranch: r.default_branch as string, url: r.html_url as string, private: !!r.private };
  }

  async listCommits(fullName: string, since: Date, limit: number): Promise<GhCommit[]> {
    const list = await this.get<any[]>(`/repos/${fullName}/commits?since=${since.toISOString()}&per_page=${Math.min(limit, 100)}`);
    // File-level detail costs one request per commit, so it is fetched for the newest few only.
    const detailBudget = this.token ? 30 : 5;
    return Promise.all(
      list.slice(0, limit).map(async (c, i) => {
        let detail: any = null;
        if (i < detailBudget) detail = await this.get(`/repos/${fullName}/commits/${c.sha}`).catch(() => null);
        return {
          sha: c.sha,
          message: c.commit?.message ?? '',
          authorName: c.commit?.author?.name ?? null,
          authorLogin: c.author?.login ?? null,
          committedAt: new Date(c.commit?.committer?.date ?? c.commit?.author?.date),
          url: c.html_url ?? null,
          additions: detail?.stats?.additions ?? null,
          deletions: detail?.stats?.deletions ?? null,
          filesChanged:
            detail?.files?.slice(0, 60).map((f: any) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, status: f.status })) ?? null,
        };
      }),
    );
  }

  async listPullRequests(fullName: string, since: Date, limit: number): Promise<GhPullRequest[]> {
    const list = await this.get<any[]>(`/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=${Math.min(limit, 100)}`);
    return list.filter((p) => new Date(p.updated_at) >= since).map(mapPull);
  }
}

export function mapPull(p: any): GhPullRequest {
  return {
    number: p.number,
    title: p.title,
    body: p.body ? String(p.body).slice(0, 8000) : null,
    state: p.merged_at ? 'merged' : p.state,
    authorLogin: p.user?.login ?? null,
    url: p.html_url ?? null,
    baseBranch: p.base?.ref ?? null,
    headBranch: p.head?.ref ?? null,
    mergeCommitSha: p.merge_commit_sha ?? null,
    labels: (p.labels ?? []).map((l: any) => l.name),
    openedAt: new Date(p.created_at),
    mergedAt: p.merged_at ? new Date(p.merged_at) : null,
    closedAt: p.closed_at ? new Date(p.closed_at) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ───────────────────────── Mock adapter ─────────────────────────

const MOCK_CHANGES = [
  { title: 'Tune connection pool sizing', files: ['src/db/pool.ts', 'config/default.yaml'], label: 'performance' },
  { title: 'Add retry with backoff to outbound HTTP client', files: ['src/clients/http.ts', 'src/clients/http.test.ts'], label: 'reliability' },
  { title: 'Bump dependencies', files: ['package.json', 'package-lock.json'], label: 'dependencies' },
  { title: 'Refactor request validation middleware', files: ['src/middleware/validate.ts', 'src/routes/index.ts'], label: 'refactor' },
  { title: 'Cache lookups for hot read path', files: ['src/cache/lookup.ts', 'src/services/read.ts'], label: 'performance' },
  { title: 'Fix null handling in response serializer', files: ['src/serializers/response.ts'], label: 'bug' },
  { title: 'Add structured logging to worker', files: ['src/worker/index.ts', 'src/lib/logger.ts'], label: 'observability' },
  { title: 'Reduce request timeout for upstream calls', files: ['config/default.yaml', 'src/clients/upstream.ts'], label: 'config' },
];
const MOCK_AUTHORS = ['asha-rao', 'm-okafor', 'lena-fischer', 'tkim', 'diego-s'];

/** Deterministic pseudo-random stream so repeated syncs produce identical sample data. */
function seeded(seed: string) {
  let state = parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export class MockGithubAdapter implements GithubAdapter {
  readonly kind = 'mock' as const;

  async whoAmI() {
    return null;
  }

  async getRepository(fullName: string) {
    return { fullName, defaultBranch: 'main', url: `https://github.com/${fullName}`, private: false };
  }

  private generate(fullName: string) {
    // One change roughly every 9 hours over the past 14 days, anchored to whole days so syncs are idempotent.
    const rand = seeded(fullName);
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const items: { commit: GhCommit; pull: GhPullRequest }[] = [];
    for (let i = 0; i < 36; i++) {
      const at = new Date(dayStart - i * 9 * 3600_000 - Math.floor(rand() * 3 * 3600_000));
      const change = MOCK_CHANGES[Math.floor(rand() * MOCK_CHANGES.length)]!;
      const author = MOCK_AUTHORS[Math.floor(rand() * MOCK_AUTHORS.length)]!;
      const sha = createHash('sha1').update(`${fullName}:${i}:${at.toISOString().slice(0, 10)}`).digest('hex');
      const number = 400 - i;
      const files = change.files.map((filename) => ({ filename, additions: 3 + Math.floor(rand() * 60), deletions: Math.floor(rand() * 25), status: 'modified' }));
      items.push({
        commit: {
          sha,
          message: `${change.title} (#${number})`,
          authorName: author,
          authorLogin: author,
          committedAt: at,
          url: null,
          additions: files.reduce((a, f) => a + f.additions, 0),
          deletions: files.reduce((a, f) => a + f.deletions, 0),
          filesChanged: files,
        },
        pull: {
          number,
          title: change.title,
          body: 'Sample pull request generated by the OpsPilot mock GitHub adapter.',
          state: 'merged',
          authorLogin: author,
          url: null,
          baseBranch: 'main',
          headBranch: `${author}/${change.label}-${number}`,
          mergeCommitSha: sha,
          labels: [change.label],
          openedAt: new Date(at.getTime() - 5 * 3600_000),
          mergedAt: at,
          closedAt: at,
        },
      });
    }
    return items.filter((i) => i.commit.committedAt.getTime() <= Date.now());
  }

  async listCommits(fullName: string, since: Date, limit: number) {
    return this.generate(fullName).map((i) => i.commit).filter((c) => c.committedAt >= since).slice(0, limit);
  }

  async listPullRequests(fullName: string, since: Date, limit: number) {
    return this.generate(fullName).map((i) => i.pull).filter((p) => p.openedAt >= since).slice(0, limit);
  }
}
