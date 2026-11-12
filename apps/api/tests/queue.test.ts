import IORedis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationEvent } from '../src/integrations/aiService';

// Unlike the rest of the suite, this file runs jobs through real BullMQ queues and workers on
// Redis. Only the Python AI service is replaced by a scripted double, so no model is ever called.
// A private key prefix keeps these queues apart from any worker already using the same Redis.
const settings = vi.hoisted(() => {
  const prefix = `opspilot-test-${process.pid}-${Date.now()}`;
  process.env.QUEUE_INLINE = 'false';
  process.env.QUEUE_PREFIX = prefix;
  process.env.QUEUE_BACKOFF_MS = '40';
  return { prefix, redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379' };
});

const ai = vi.hoisted(() => ({
  embedFailures: 0,
  embedCalls: 0,
  events: [] as unknown[],
  runs: [] as string[],
  runDelayMs: 0,
}));

vi.mock('../src/integrations/aiService', () => ({
  aiService: {
    status: async () => ({ llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'unit', dimensions: 768 } }),
    embed: async (texts: string[]) => {
      ai.embedCalls += 1;
      if (ai.embedFailures > 0) {
        ai.embedFailures -= 1;
        throw new Error('AI service is not reachable');
      }
      return { provider: 'test', model: 'unit', dimensions: 768, vectors: texts.map(() => [1, ...new Array(767).fill(0)]) };
    },
    runInvestigation: async (request: { question: string }, onEvent: (e: InvestigationEvent) => Promise<void>) => {
      ai.runs.push(request.question);
      if (ai.runDelayMs) await new Promise((r) => setTimeout(r, ai.runDelayMs));
      for (const event of ai.events) await onEvent(event as InvestigationEvent);
    },
  },
}));

import { closeQueues, queueStats, startWorkers } from '../src/queues';
import { createOrg, prisma } from './helpers';

const redisAvailable = await (async () => {
  const probe = new IORedis(settings.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500, retryStrategy: () => null });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
})();
// In CI a missing Redis is a failure, never a silent skip.
if (!redisAvailable && process.env.CI) throw new Error(`Queue tests need Redis at ${settings.redisUrl}`);
if (!redisAvailable) console.warn(`Skipping queue reliability tests: Redis is not reachable at ${settings.redisUrl}`);

const emptyReport = { summary: 'Nothing conclusive was found.', confidence: 0.1, analysisMode: 'heuristic', timeline: [], facts: [], assumptions: [], uncertainties: [], hypotheses: [], nextSteps: [], recommendedActions: [] };
const QUESTION = 'Why is checkout failing today?';

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const counts = async (name: string) => (await queueStats()).find((q) => q.name === name) as { name: string } & Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed', number>;

describe.skipIf(!redisAvailable)('queue reliability (BullMQ on Redis, AI service mocked)', () => {
  let stop: (() => Promise<void>) | undefined;
  const start = async () => (stop = await startWorkers({ schedulers: false }));
  const halt = async () => {
    await stop?.();
    stop = undefined;
  };

  beforeAll(async () => {
    expect(process.env.QUEUE_PREFIX).toBe(settings.prefix);
  });
  beforeEach(() => {
    ai.embedFailures = 0;
    ai.embedCalls = 0;
    ai.events = [{ type: 'final', report: emptyReport }];
    ai.runs = [];
    ai.runDelayMs = 0;
  });
  afterEach(halt);
  afterAll(async () => {
    await closeQueues();
    const redis = new IORedis(settings.redisUrl);
    const keys = await redis.keys(`${settings.prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('holds an investigation in the queue until a worker starts, then runs it exactly once', async () => {
    const org = await createOrg();
    const started = await org.owner.post('/api/v1/investigations').send({ question: QUESTION });
    expect(started.status).toBe(202);
    const read = async () => (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;

    // No worker is running: the request returned at once and the job is waiting in Redis.
    expect((await read()).status).toBe('QUEUED');
    expect(await counts('investigation')).toMatchObject({ waiting: 1, active: 0 });
    expect(ai.runs).toHaveLength(0);

    await start();
    const done = await until(read, (i) => i.status !== 'QUEUED' && i.status !== 'RUNNING', 'the investigation to finish');
    expect(done).toMatchObject({ status: 'COMPLETED', analysisMode: 'heuristic' });
    expect(ai.runs).toEqual([QUESTION]);
    expect(await until(() => counts('investigation'), (c) => c.completed === 1, 'the job to be marked completed')).toMatchObject({ waiting: 0, active: 0, failed: 0 });
  });

  it('processes a burst of investigations once each, and survives a worker restart in between', async () => {
    const org = await createOrg();
    const before = (await counts('investigation')).completed;
    ai.runDelayMs = 60;
    await start();
    const first = await Promise.all([1, 2, 3].map((n) => org.owner.post('/api/v1/investigations').send({ question: `${QUESTION} (${n})` })));
    expect(first.map((r) => r.status)).toEqual([202, 202, 202]);
    const finished = async () => prisma.investigation.count({ where: { organizationId: org.organizationId, status: 'COMPLETED' } });
    await until(finished, (n) => n === 3, 'three investigations to complete');

    // A graceful shutdown waits for running jobs; work submitted while the worker is down is kept.
    await halt();
    const later = await org.owner.post('/api/v1/investigations').send({ question: `${QUESTION} (4)` });
    expect(later.status).toBe(202);
    expect((await org.owner.get(`/api/v1/investigations/${later.body.id}`)).body.status).toBe('QUEUED');
    await start();
    await until(finished, (n) => n === 4, 'the investigation queued during the restart to complete');

    expect([...ai.runs].sort()).toEqual([1, 2, 3, 4].map((n) => `${QUESTION} (${n})`));
    await until(() => counts('investigation'), (c) => c.completed - before === 4 && c.active === 0, 'all four jobs to be marked completed');
  });

  it('records a failed investigation as failed without retrying it', async () => {
    const org = await createOrg();
    ai.events = [{ type: 'error', message: 'model exploded' }];
    await start();
    const started = await org.owner.post('/api/v1/investigations').send({ question: QUESTION });
    const read = async () => (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;
    expect(await until(read, (i) => i.status === 'FAILED', 'the investigation to fail')).toMatchObject({ error: 'model exploded' });
    // Investigations cost money, so they are attempted once only.
    await new Promise((r) => setTimeout(r, 300));
    expect(ai.runs).toHaveLength(1);
  });

  it('retries knowledge indexing with backoff until the embedding service recovers', async () => {
    const org = await createOrg();
    ai.embedFailures = 2;
    await start();
    const created = await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Pool runbook', type: 'runbook', content: '# Pool runbook\n\nRaise DB_POOL_MAX when connections time out.' });
    expect(created.status).toBe(201);
    const read = async () => prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: created.body.id } });
    const doc = await until(read, (d) => d.indexStatus === 'indexed', 'the document to be indexed');
    expect(doc).toMatchObject({ indexError: null, embeddingModel: 'test:unit' });
    expect(ai.embedCalls).toBe(3);
    expect(await counts('knowledge-index')).toMatchObject({ failed: 0, delayed: 0 });
  });

  it('gives up after the configured attempts, keeps the failed job and leaves the document keyword-searchable', async () => {
    const org = await createOrg();
    const before = (await counts('knowledge-index')).failed;
    ai.embedFailures = 100;
    await start();
    const created = await org.owner.post('/api/v1/knowledge/documents').send({ title: 'SMTP runbook', type: 'runbook', content: '# SMTP runbook\n\nRestart the relay when mail queues grow.' });
    expect(created.status).toBe(201);
    await until(() => counts('knowledge-index'), (c) => c.failed === before + 1, 'the job to exhaust its retries');
    expect(ai.embedCalls).toBe(3);
    const doc = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(doc.indexStatus).toBe('failed');
    expect(doc.indexError).toContain('not reachable');
    expect(await prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBeGreaterThan(0);
    // Nothing is retried again afterwards.
    await new Promise((r) => setTimeout(r, 300));
    expect(ai.embedCalls).toBe(3);
  });
});
