import { type JobsOptions, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { jobDuration, jobsProcessed } from '../lib/metrics';

/** Payloads for every background job in the system. */
export interface JobPayloads {
  investigation: { investigationId: string };
  'knowledge-index': { documentId: string };
  'github-sync': { organizationId: string; repositoryId?: string };
  'alert-eval': Record<string, never>;
  'log-retention': Record<string, never>;
}
export type JobName = keyof JobPayloads;

type Processor<N extends JobName> = (data: JobPayloads[N]) => Promise<void>;

const CONFIG: Record<JobName, { concurrency: number; attempts: number }> = {
  investigation: { concurrency: 2, attempts: 1 },
  'knowledge-index': { concurrency: 2, attempts: 3 },
  'github-sync': { concurrency: 1, attempts: 2 },
  'alert-eval': { concurrency: 1, attempts: 1 },
  'log-retention': { concurrency: 1, attempts: 1 },
};

// Feature modules register their processors here; this file never imports a feature module,
// which keeps the dependency graph acyclic.
const processors = new Map<JobName, Processor<JobName>>();

export function registerProcessor<N extends JobName>(name: N, processor: Processor<N>) {
  processors.set(name, processor as unknown as Processor<JobName>);
}

let connection: IORedis | undefined;
const queues = new Map<JobName, Queue>();

function redis() {
  // BullMQ requires maxRetriesPerRequest: null on its blocking connections.
  connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function queueFor(name: JobName) {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redis() });
    queues.set(name, queue);
  }
  return queue;
}

async function run(name: JobName, data: unknown) {
  const processor = processors.get(name);
  if (!processor) throw new Error(`No processor registered for job "${name}"`);
  const stop = jobDuration.startTimer({ queue: name });
  try {
    await processor(data as JobPayloads[JobName]);
    jobsProcessed.inc({ queue: name, status: 'completed' });
  } catch (err) {
    jobsProcessed.inc({ queue: name, status: 'failed' });
    throw err;
  } finally {
    stop();
  }
}

export async function enqueue<N extends JobName>(name: N, data: JobPayloads[N], options: JobsOptions = {}) {
  if (env.QUEUE_INLINE) {
    // Test mode: run synchronously in-process so tests need no Redis and no worker.
    await run(name, data).catch((err) => logger.error({ err, queue: name }, 'inline job failed'));
    return;
  }
  await queueFor(name).add(name, data, {
    attempts: CONFIG[name].attempts,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
    ...options,
  });
}

/** Started only by the worker process (src/worker.ts). */
export async function startWorkers() {
  const workers = (Object.keys(CONFIG) as JobName[]).map((name) => {
    const worker = new Worker(name, async (job) => run(name, job.data), { connection: redis(), concurrency: CONFIG[name].concurrency });
    worker.on('failed', (job, err) => logger.error({ err, queue: name, jobId: job?.id }, 'job failed'));
    worker.on('completed', (job) => logger.debug({ queue: name, jobId: job.id }, 'job completed'));
    return worker;
  });
  await queueFor('alert-eval').upsertJobScheduler('alert-eval-every-minute', { every: 60_000 }, { name: 'alert-eval', data: {} });
  await queueFor('log-retention').upsertJobScheduler('log-retention-hourly', { every: 3_600_000 }, { name: 'log-retention', data: {} });
  logger.info({ queues: Object.keys(CONFIG) }, 'workers started');
  return async () => {
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
  };
}

export async function queueStats() {
  if (env.QUEUE_INLINE) return [];
  return Promise.all(
    (Object.keys(CONFIG) as JobName[]).map(async (name) => ({
      name,
      ...(await queueFor(name).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')),
    })),
  );
}

export async function redisPing(): Promise<boolean> {
  if (env.QUEUE_INLINE) return true;
  try {
    return (await redis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await connection?.quit().catch(() => undefined);
  connection = undefined;
}
