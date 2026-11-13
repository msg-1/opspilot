import IORedis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REPORT, aiStub, hostPort, pause, spawnWorker, tcpProxy, testPort, until } from './faults';

// What happens to an investigation when something around it fails: the AI service, Redis, or
// the worker itself. Real BullMQ on Redis, the real AI client over HTTP, and for crashes a real
// worker process. Redis is reached through a proxy that can be switched off, so an outage here
// never touches the Redis server itself. The AI service is a scripted stub: no model is called.
const settings = vi.hoisted(() => {
  const port = (offset: number) => 21_000 + ((process.pid * 7 + offset * 131) % 20_000);
  const realRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const prefix = `opspilot-reliability-${process.pid}-${Date.now()}`;
  process.env.QUEUE_INLINE = 'false';
  process.env.QUEUE_PREFIX = prefix;
  process.env.REDIS_URL = `redis://127.0.0.1:${port(1)}`;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${port(2)}`;
  // A dead worker's job is handed on after about a second instead of a minute.
  process.env.QUEUE_LOCK_MS = '600';
  process.env.QUEUE_STALLED_INTERVAL_MS = '300';
  return { realRedis, prefix, redisPort: port(1), aiPort: port(2), workerPort: port(3) };
});

import { env } from '../src/config/env';
import { runInvestigation } from '../src/modules/investigations';
import { reapStranded } from '../src/modules/system';
import { closeQueues, enqueue, ensureSchedulers, queueStats, startWorkers } from '../src/queues';
import { api, createOrg, createService, prisma } from './helpers';

expect(testPort(1)).toBe(settings.redisPort);
const redisProxy = tcpProxy(settings.redisPort, hostPort(settings.realRedis, 6379));
const ai = aiStub(settings.aiPort);

const redisAvailable = await (async () => {
  const probe = new IORedis(settings.realRedis, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500, retryStrategy: () => null });
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
if (!redisAvailable && process.env.CI) throw new Error(`Reliability tests need Redis at ${settings.realRedis}`);
if (!redisAvailable) console.warn(`Skipping reliability tests: Redis is not reachable at ${settings.realRedis}`);

type Org = Awaited<ReturnType<typeof createOrg>>;
const QUESTION = 'Why is checkout failing today?';
const ask = (org: Org, question = QUESTION) => org.owner.post('/api/v1/investigations').send({ question });
const read = async (org: Org, id: string) => (await org.owner.get(`/api/v1/investigations/${id}`)).body;
const ended = (org: Org, id: string, timeoutMs?: number) => until(() => read(org, id), (i) => !['QUEUED', 'RUNNING'].includes(i.status), 'the investigation to end', timeoutMs);
const inState = (org: Org, id: string, status: string) => until(() => read(org, id), (i) => i.status === status, `the investigation to be ${status}`);
const counts = async () => (await queueStats()).find((q) => q.name === 'investigation') as unknown as Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed', number>;
/** Nothing that only a finished investigation may have. */
const expectNoConclusions = async (detail: Record<string, unknown> & { id: string }) => {
  expect(detail).toMatchObject({ report: null, summary: null, outcome: null, hypotheses: [], remediations: [] });
  expect(await prisma.remediationAction.count({ where: { investigationId: detail.id } })).toBe(0);
};

// A report that survives the guardrails with one production change in it.
const evidence = (ref: string, kind: string, title: string) => ({ type: 'evidence', evidence: { ref, kind, title, summary: `${title} summary`, sourceType: kind, sourceId: `${kind}-${ref}` } });
const ROLLBACK_EVENTS = [
  { type: 'meta', provider: 'heuristic', model: null },
  evidence('E1', 'deployment', 'Deployment of orders v1.5.0'),
  evidence('E2', 'log_pattern', '300× ERROR in orders'),
  {
    type: 'final',
    report: {
      summary: 'Errors began after v1.5.0.', confidence: 0.57, analysisMode: 'heuristic', outcome: 'INCIDENT',
      assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E2'], signals: [], missingTelemetry: [] },
      hypotheses: [{ title: 'Regression introduced by v1.5.0', description: 'd', confidence: 0.57, status: 'likely', evidenceRefs: ['E1', 'E2'], facts: [], assumptions: [], gaps: [] }],
      facts: [], timeline: [], assumptions: [], uncertainties: ['x'], nextSteps: [],
      recommendedActions: [{ type: 'rollback_deployment', title: 'Roll back orders to v1.4.0', description: 'Return to the previous version.', risk: 'MEDIUM', serviceSlug: 'orders', parameters: { deploymentId: 'deployment-E1', toVersion: 'v1.4.0' }, evidenceRefs: ['E1', 'E2'] }],
    },
  },
];

describe.skipIf(!redisAvailable)('reliability under failure', () => {
  let stop: ((options?: { graceMs?: number }) => Promise<void>) | undefined;
  const start = async () => (stop = await startWorkers({ schedulers: false }));
  const halt = async () => {
    // A run left hanging by a test is stopped, not waited for.
    await stop?.({ graceMs: 200 });
    stop = undefined;
  };

  beforeAll(async () => {
    await redisProxy.up();
    await ai.start();
    // The sweep puts waiting investigations back on the queue, whoever they belong to. None
    // left over from an earlier file may wander into this file's queue and be counted here.
    await prisma.investigation.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
  });
  beforeEach(async () => {
    ai.reset();
    env.INVESTIGATION_TIMEOUT_MS = 15 * 60_000;
    await redisProxy.up();
    await ai.start();
  });
  afterEach(halt);
  afterAll(async () => {
    await closeQueues();
    await ai.stop();
    await redisProxy.down();
    const redis = new IORedis(settings.realRedis);
    const keys = await redis.keys(`${settings.prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  describe('the AI service', () => {
    it('is not there: the investigation fails saying so, and the next one works once it is back', async () => {
      const org = await createOrg();
      await ai.stop();
      await start();
      const failed = await ended(org, (await ask(org)).body.id);
      expect(failed).toMatchObject({ status: 'FAILED', analysisMode: null });
      expect(failed.error).toContain('AI service is not reachable');
      expect(failed.completedAt).toBeTruthy();
      expect(failed.steps.at(-1)).toMatchObject({ type: 'error', title: 'Investigation failed', status: 'failed' });
      await expectNoConclusions(failed);
      // The person who asked is told, and the system says the service is unreachable instead of guessing.
      expect(await until(() => prisma.notification.count({ where: { organizationId: org.organizationId, type: 'investigation.failed' } }), (n) => n >= 1, 'the follow-up record to be written')).toBe(1);
      expect((await org.owner.get('/api/v1/investigations/ai-status')).body).toMatchObject({ reachable: false });

      // Recovery: nothing to repair, no restart. The same worker runs the next one to a stored report.
      await ai.start();
      const next = await ended(org, (await ask(org)).body.id);
      expect(next).toMatchObject({ status: 'COMPLETED', analysisMode: 'heuristic', error: null, report: expect.objectContaining({ summary: EMPTY_REPORT.summary }) });
      // A handled failure is not a failed job, and investigations are never retried by the queue.
      expect(await until(counts, (c) => c.active === 0 && c.completed >= 2, 'both jobs to be settled')).toMatchObject({ failed: 0, delayed: 0, waiting: 0 });
      expect(ai.state.runs).toHaveLength(1);
    });

    it('answers with an error: recorded as a failure, not retried', async () => {
      const org = await createOrg();
      ai.state.onRun = (_req, res) => void res.writeHead(500, { 'content-type': 'application/json' }).end('{"detail":"engine crashed"}');
      await start();
      const failed = await ended(org, (await ask(org)).body.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('AI service returned 500');
      await expectNoConclusions(failed);
      await pause(400);
      expect(ai.state.runs).toHaveLength(1);
    });

    it.each([
      ['never answers', false],
      ['starts answering and then stalls', true],
    ])('%s: the investigation is stopped at the time limit and the request is abandoned', async (_name, answers) => {
      const org = await createOrg();
      ai.state.onRun = (_req, _res, { line }) => {
        if (answers) {
          line({ type: 'meta', provider: 'heuristic', model: null });
          line(evidence('E1', 'log_pattern', '12× ERROR in checkout'));
        }
        // …and nothing more, with the connection left open.
      };
      env.INVESTIGATION_TIMEOUT_MS = 500;
      await start();
      const began = Date.now();
      const failed = await ended(org, (await ask(org)).body.id);
      expect(Date.now() - began).toBeLessThan(5000);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('did not finish within 500 ms');
      // What was gathered stays on record as gathered; nothing is concluded from it.
      expect(failed.evidence).toHaveLength(answers ? 1 : 0);
      await expectNoConclusions(failed);
      // The AI service is not left working for nobody.
      await until(async () => ai.state.abandoned, (n) => n === 1, 'the request to the AI service to be closed');
    });

    it('breaks off in the middle of the stream: failed, with the evidence so far and no report', async () => {
      const org = await createOrg();
      ai.state.onRun = async (_req, res, { line }) => {
        line({ type: 'meta', provider: 'heuristic', model: null });
        line(evidence('E1', 'log_pattern', '12× ERROR in checkout'));
        res.write('{"type":"evidence","evidence":{"ref":"E2","kind":"log_pattern","title":"cut off he'); // no end of line: the event never arrives in full
        await pause(100);
        res.destroy();
      };
      await start();
      const failed = await ended(org, (await ask(org)).body.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('The connection to the AI service was interrupted before the investigation finished');
      expect(failed.evidence.map((e: { ref: string }) => e.ref)).toEqual(['E1']);
      await expectNoConclusions(failed);

      // The same when the connection is closed in an orderly way half-way through an event.
      ai.state.onRun = (_req, res, { line }) => {
        line({ type: 'meta', provider: 'heuristic', model: null });
        res.end('{"type":"final","report":{"summary":"Nothing conclusive');
      };
      const cut = await ended(org, (await ask(org)).body.id);
      expect(cut.status).toBe('FAILED');
      expect(cut.error).toContain('interrupted before the investigation finished');
      await expectNoConclusions(cut);
    });

    it('sends something that is not an event: stopped there, and the text is not repeated anywhere', async () => {
      const org = await createOrg();
      ai.state.onRun = (_req, res, { line }) => {
        line({ type: 'meta', provider: 'heuristic', model: null });
        line('<html>502 Bad Gateway token=hunter2-secret</html>');
        // A report after the rubbish is not trusted either: the stream is abandoned at the bad line.
        line({ type: 'final', report: EMPTY_REPORT });
        res.end();
      };
      await start();
      const failed = await ended(org, (await ask(org)).body.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('not a valid event');
      expect(JSON.stringify(failed)).not.toContain('hunter2');
      await expectNoConclusions(failed);

      // Valid JSON that is not an event is the same failure.
      ai.state.onRun = (_req, res, { line }) => {
        line('["final"]');
        res.end();
      };
      expect((await ended(org, (await ask(org)).body.id)).error).toContain('not a valid event');
    });

    it.each([
      ['ends the stream without a report', [{ type: 'meta', provider: 'heuristic', model: null }], 'without producing a report'],
      ['sends a report that does not have the shape of one', [{ type: 'final', report: { summary: 42 } }], 'malformed report'],
      ['reports its own failure', [{ type: 'error', message: 'the engine gave up' }], 'the engine gave up'],
    ])('%s: failed, never completed', async (_name, events, message) => {
      const org = await createOrg();
      ai.state.onRun = (_req, res, { line }) => {
        for (const event of events) line(event);
        res.end();
      };
      await start();
      const failed = await ended(org, (await ask(org)).body.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain(message);
      await expectNoConclusions(failed);
    });

    it('repeats itself: one report, one set of evidence, one proposed action', async () => {
      const org = await createOrg();
      await createService(org.owner, 'Orders');
      const [meta, e1, e2, final] = ROLLBACK_EVENTS;
      ai.state.onRun = (_req, res, { line }) => {
        for (const event of [meta, e1, e1, e2, final, e2, final]) line(event);
        res.end();
      };
      await start();
      const id = (await ask(org)).body.id as string;
      await ended(org, id);
      // The proposed action is written just after the report is stored, not with it: wait for it.
      const done = await until(() => read(org, id), (i) => i.remediations.length > 0, 'the proposed action to be recorded');
      expect(done).toMatchObject({ status: 'COMPLETED', outcome: 'INCIDENT' });
      expect(done.evidence.map((e: { ref: string }) => e.ref)).toEqual(['E1', 'E2']);
      expect(done.hypotheses).toHaveLength(1);
      expect(done.remediations).toEqual([expect.objectContaining({ type: 'rollback_deployment', status: 'PROPOSED' })]);
      await pause(200);
      expect(await prisma.remediationAction.count({ where: { organizationId: org.organizationId } })).toBe(1);
      expect(await until(() => prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'investigation.complete' } }), (n) => n >= 1, 'the follow-up record to be written')).toBe(1);
      expect(await until(() => prisma.notification.count({ where: { organizationId: org.organizationId, type: 'investigation.completed' } }), (n) => n >= 1, 'the follow-up record to be written')).toBe(1);
    });
  });

  describe('the same work arriving twice', () => {
    it('is run once: by job id in the queue, and by the claim on the investigation', async () => {
      const org = await createOrg();
      await createService(org.owner, 'Orders');
      ai.state.onRun = async (_req, res, { line }) => {
        await pause(150);
        for (const event of ROLLBACK_EVENTS) line(event);
        res.end();
      };
      const before = await counts();
      const id = (await ask(org)).body.id as string;
      // The same job put on the queue again, as a retried request or a replayed message would.
      await enqueue('investigation', { investigationId: id }, { jobId: id });
      await enqueue('investigation', { investigationId: id }, { jobId: id });
      expect((await counts()).waiting - before.waiting).toBe(1);
      // And under different job ids, so that only the claim on the row can stop the second run.
      await enqueue('investigation', { investigationId: id }, { jobId: `${id}-again` });
      await start();
      const done = await ended(org, id);
      expect(done.status).toBe('COMPLETED');
      await until(counts, (c) => c.active === 0 && c.waiting === 0, 'the queue to drain');
      await until(() => prisma.remediationAction.count({ where: { organizationId: org.organizationId } }), (n) => n > 0, 'the proposed action to be recorded');
      // Processing it again by hand, during and after, changes nothing either.
      await Promise.all([runInvestigation(id), runInvestigation(id), runInvestigation(id, { redelivered: true })]);
      expect(ai.state.runs).toHaveLength(1);
      expect(await prisma.remediationAction.count({ where: { organizationId: org.organizationId } })).toBe(1);
      expect(await prisma.hypothesis.count({ where: { investigationId: id } })).toBe(1);
      expect((await read(org, id)).status).toBe('COMPLETED');
    });

    it('a cancelled investigation stays cancelled, even when its report arrives afterwards', async () => {
      const org = await createOrg();
      await createService(org.owner, 'Orders');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const [meta, e1, e2, final] = ROLLBACK_EVENTS;
      ai.state.onRun = async (_req, res, { line }) => {
        line(meta);
        line(e1);
        await gate;
        line(e2);
        await pause(300);
        line(final);
        res.end();
      };
      await start();
      const id = (await ask(org)).body.id as string;
      await until(() => read(org, id), (i) => i.status === 'RUNNING' && i.evidence.length === 1, 'the run to be under way');
      await org.owner.post(`/api/v1/investigations/${id}/cancel`).expect(200);
      release();
      await until(async () => ai.state.abandoned, (n) => n === 1, 'the request to the AI service to be dropped');
      await pause(300);
      const cancelled = await read(org, id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.error).toBeNull();
      await expectNoConclusions(cancelled);
      // Cancelling something that already ended is refused, not silently accepted.
      expect((await org.owner.post(`/api/v1/investigations/${id}/cancel`)).status).toBe(409);
    });
  });

  describe('Redis', () => {
    it('is down when an investigation is requested: refused, recorded as failed, and working again without a restart', async () => {
      const org = await createOrg();
      await start();
      const first = await ended(org, (await ask(org)).body.id);
      expect(first.status).toBe('COMPLETED');

      await redisProxy.down();
      const began = Date.now();
      const refused = await ask(org);
      expect(Date.now() - began).toBeLessThan(8000); // it answers; it does not hang
      expect(refused.status).toBe(503);
      expect(refused.body.error).toMatchObject({ code: 'service_unavailable' });
      expect(refused.body.error.message).toContain('Nothing was started');
      // Nothing is left looking as if it were waiting for a worker.
      const rows = await prisma.investigation.findMany({ where: { organizationId: org.organizationId }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.status)).toEqual(['COMPLETED', 'FAILED']);
      expect(rows[1]!.error).toContain('Redis');
      expect((await api().get('/ready')).body).toMatchObject({ status: 'not_ready', redis: false, database: true });
      expect((await api().get('/ready')).status).toBe(503);
      // Everything that does not need the queue still works.
      expect((await org.owner.get('/api/v1/incidents')).status).toBe(200);

      await redisProxy.up();
      await until(async () => (await api().get('/ready')).status, (s) => s === 200, 'the API to be ready again');
      const next = await ended(org, (await until(() => ask(org), (r) => r.status === 202, 'an investigation to be accepted')).body.id);
      expect(next.status).toBe('COMPLETED');
      expect(ai.state.runs).toHaveLength(2);
    });

    it('goes away while an investigation is running: it finishes once, and nothing runs twice', async () => {
      const org = await createOrg();
      await createService(org.owner, 'Orders');
      ai.state.onRun = async (_req, res, { line }) => {
        line(ROLLBACK_EVENTS[0]);
        await pause(2500);
        for (const event of ROLLBACK_EVENTS.slice(1)) line(event);
        res.end();
      };
      await start();
      const id = (await ask(org)).body.id as string;
      await inState(org, id, 'RUNNING');
      // Longer than the worker's claim on the job lasts: the queue will hand the job out again.
      await redisProxy.down();
      await pause(1500);
      await redisProxy.up();
      const done = await ended(org, id);
      expect(done).toMatchObject({ status: 'COMPLETED', outcome: 'INCIDENT' });
      await until(counts, (c) => c.active === 0 && c.waiting === 0, 'the queue to settle');
      await until(() => prisma.remediationAction.count({ where: { organizationId: org.organizationId } }), (n) => n > 0, 'the proposed action to be recorded');
      await pause(500);
      expect(ai.state.runs).toHaveLength(1);
      expect((await read(org, id)).status).toBe('COMPLETED');
      expect(await prisma.remediationAction.count({ where: { organizationId: org.organizationId } })).toBe(1);
      // The worker is still serving the queue.
      ai.reset();
      expect((await ended(org, (await ask(org)).body.id)).status).toBe('COMPLETED');
    });

    it('loses its data while an investigation is waiting: the sweep puts the job back, once, and it runs', async () => {
      const org = await createOrg();
      const raw = new IORedis(settings.realRedis);
      const wipe = async (queue: string) => {
        const keys = await raw.keys(`${settings.prefix}:${queue}:*`);
        if (keys.length) await raw.del(...keys);
      };
      try {
        const id = (await ask(org)).body.id as string; // accepted; no worker is running
        expect((await counts()).waiting).toBe(1);
        await wipe('investigation');
        expect((await counts()).waiting).toBe(0);
        expect((await read(org, id)).status).toBe('QUEUED'); // it looks as if it were waiting; nothing will ever pick it up

        // Too recent to be suspected: an investigation normally waits a moment.
        await reapStranded();
        expect((await counts()).waiting).toBe(0);
        // After a few minutes of waiting its job is put back, and only once however often the sweep runs.
        await prisma.investigation.update({ where: { id }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
        await reapStranded();
        await reapStranded();
        expect((await counts()).waiting).toBe(1);

        await start();
        expect((await ended(org, id)).status).toBe('COMPLETED');
        await until(counts, (c) => c.active === 0 && c.waiting === 0, 'the queue to drain');
        // Sweeping again after it ran does not run it again.
        await reapStranded();
        await pause(300);
        expect(ai.state.runs.filter((r) => r.investigationId === id)).toHaveLength(1);

        // The repeating jobs (alert evaluation, retention, and this sweep) live in Redis too.
        await ensureSchedulers();
        expect(await ensureSchedulers()).toEqual([]); // present: left alone
        await wipe('alert-eval');
        await wipe('log-retention');
        expect((await ensureSchedulers()).sort()).toEqual(['alert-eval-every-minute', 'log-retention-hourly']);
        expect(await ensureSchedulers()).toEqual([]);
      } finally {
        await halt();
        await wipe('alert-eval');
        await wipe('log-retention');
        await raw.quit();
      }
    });

    it('is not there when the workers start: they wait for it instead of failing', async () => {
      const org = await createOrg();
      await redisProxy.down();
      await start(); // does not throw
      await pause(500);
      await redisProxy.up();
      const id = (await until(() => ask(org), (r) => r.status === 202, 'an investigation to be accepted')).body.id as string;
      expect((await ended(org, id)).status).toBe('COMPLETED');
    });
  });

  describe('the worker process', () => {
    const workerEnv = (extra: Record<string, string> = {}) => ({ WORKER_PORT: String(settings.workerPort), WORKER_SHUTDOWN_GRACE_MS: '5000', ...extra });
    const ready = (worker: Awaited<ReturnType<typeof spawnWorker>>) => until(() => worker.probe('/ready'), (r) => r.status === 200, 'the worker to be ready', 30_000);
    const hang = () => {
      ai.state.onRun = (_req, _res, { line }) => {
        line({ type: 'meta', provider: 'heuristic', model: null });
        line(evidence('E1', 'log_pattern', '12× ERROR in checkout'));
      };
    };

    it('is killed in the middle of an investigation: the next worker records it as interrupted, promptly, and does not run it again', async () => {
      const org = await createOrg();
      hang();
      const first = await spawnWorker(workerEnv());
      await ready(first);
      const id = (await ask(org)).body.id as string;
      await until(() => read(org, id), (i) => i.status === 'RUNNING' && i.evidence.length === 1, 'the run to be under way');
      await first.kill();
      // Nobody is running it, and nothing can know that yet.
      expect((await read(org, id)).status).toBe('RUNNING');

      ai.reset();
      const second = await spawnWorker(workerEnv());
      try {
        const began = Date.now();
        const failed = await ended(org, id, 30_000);
        expect(Date.now() - began).toBeLessThan(15_000); // not the 20 minutes of the periodic sweep
        expect(failed.status).toBe('FAILED');
        expect(failed.error).toContain('the worker stopped before this investigation finished');
        expect(failed.steps.at(-1)).toMatchObject({ type: 'error', title: 'Investigation interrupted', status: 'failed' });
        expect(failed.evidence).toHaveLength(1);
        await expectNoConclusions(failed);
        expect(await until(() => prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'investigation.interrupted' } }), (n) => n >= 1, 'the follow-up record to be written')).toBe(1);
        expect(await until(() => prisma.notification.count({ where: { organizationId: org.organizationId, type: 'investigation.failed' } }), (n) => n >= 1, 'the follow-up record to be written')).toBe(1);
        // It was not started a second time: with a model that would be a second charge.
        await pause(800);
        expect(ai.state.runs).toHaveLength(0);
        expect((await read(org, id)).status).toBe('FAILED');

        // The replacement worker does the next piece of work.
        const next = await ended(org, (await ask(org)).body.id);
        expect(next).toMatchObject({ status: 'COMPLETED', report: expect.objectContaining({ summary: EMPTY_REPORT.summary }) });
        expect(ai.state.runs).toHaveLength(1);
      } finally {
        expect(await second.terminate()).toBe(0);
      }
    }, 90_000);

    it('is asked to stop: a run that can finish in the grace period does, one that cannot is recorded as interrupted before the process exits', async () => {
      const org = await createOrg();
      // Finishes in time.
      ai.state.onRun = async (_req, res, { line }) => {
        line({ type: 'meta', provider: 'heuristic', model: null });
        await pause(700);
        line({ type: 'final', report: EMPTY_REPORT });
        res.end();
      };
      const patient = await spawnWorker(workerEnv({ WORKER_SHUTDOWN_GRACE_MS: '8000' }));
      await ready(patient);
      const finishing = (await ask(org)).body.id as string;
      await inState(org, finishing, 'RUNNING');
      expect(await patient.terminate()).toBe(0);
      expect((await read(org, finishing)).status).toBe('COMPLETED');

      // Cannot finish in time.
      hang();
      const hurried = await spawnWorker(workerEnv({ WORKER_SHUTDOWN_GRACE_MS: '300' }));
      await ready(hurried);
      const stuck = (await ask(org)).body.id as string;
      await until(() => read(org, stuck), (i) => i.status === 'RUNNING' && i.evidence.length === 1, 'the run to be under way');
      const began = Date.now();
      expect(await hurried.terminate()).toBe(0);
      expect(Date.now() - began).toBeLessThan(8000);
      // Already recorded when the process is gone: no later sweep is needed to make the record true.
      const interrupted = await read(org, stuck);
      expect(interrupted.status).toBe('FAILED');
      expect(interrupted.error).toContain('the worker stopped before this investigation finished');
      await expectNoConclusions(interrupted);
      expect(ai.state.abandoned).toBe(1);
    }, 90_000);

    it('starts without Redis: it stays up, says it is not ready, and takes work once Redis is there', async () => {
      const org = await createOrg();
      await redisProxy.down();
      const worker = await spawnWorker(workerEnv());
      try {
        expect((await worker.probe('/health')).status).toBe(200); // alive…
        expect(await worker.probe('/ready')).toMatchObject({ status: 503, body: { status: 'not_ready', redis: false, database: true } }); // …and honest about it
        await pause(1500);
        expect(worker.alive()).toBe(true);
        await redisProxy.up();
        await ready(worker);
        const id = (await until(() => ask(org), (r) => r.status === 202, 'an investigation to be accepted')).body.id as string;
        expect((await ended(org, id, 30_000)).status).toBe('COMPLETED');
      } finally {
        expect(await worker.terminate()).toBe(0);
      }
      // Its log holds no credential: neither the internal token nor a database password.
      expect(worker.output()).not.toContain(process.env.INTERNAL_SERVICE_TOKEN!);
      expect(worker.output()).not.toContain(process.env.JWT_SECRET!);
      expect(worker.output()).not.toMatch(/postgresql:\/\/[^\s"]*:[^\s"@]+@/);
    }, 90_000);
  });
});
