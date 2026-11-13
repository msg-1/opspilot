import { SpanKind } from '@opentelemetry/api';
import { type JobsOptions, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { serviceUnavailable } from '../lib/errors';
import { logger } from '../lib/logger';
import { jobDuration, jobsProcessed } from '../lib/metrics';
import { currentCarrier, type TraceCarrier, withSpan } from '../lib/tracing';

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

/**
 * A job as it sits in Redis: the payload, plus the trace context of whoever enqueued it, so
 * the worker's spans join the trace of the request that asked for the work. Processors never
 * see `_trace`; it is removed before they are called.
 */
type Envelope = Record<string, unknown> & { _trace?: TraceCarrier };

/** Ids that say which piece of work a span belongs to. Ids only: never payload content. */
function jobAttributes(name: JobName, data: Record<string, unknown>) {
  return {
    'messaging.system': 'bullmq',
    'messaging.destination.name': name,
    ...(typeof data.investigationId === 'string' ? { 'opspilot.investigation.id': data.investigationId } : {}),
    ...(typeof data.documentId === 'string' ? { 'opspilot.document.id': data.documentId } : {}),
  };
}

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
let producerConnection: IORedis | undefined;
const queues = new Map<JobName, Queue>();
const PRODUCER_TIMEOUT_MS = 3000;

/** Worker connection: BullMQ needs unlimited retries on its blocking connections. */
function redis() {
  connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

/**
 * Producer connection, used by request handlers. It must fail fast: with the offline queue on,
 * a command issued while Redis is down waits forever and the HTTP request hangs with it.
 */
function producer() {
  if (!producerConnection) {
    producerConnection = new IORedis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: PRODUCER_TIMEOUT_MS });
    // Without a listener, connection errors would be thrown as unhandled events.
    producerConnection.on('error', (err) => logger.debug({ err: err.message }, 'redis producer connection error'));
  }
  return producerConnection;
}

const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref());

/** Resolves once the producer connection is usable, or rejects quickly if Redis is not there. */
async function producerReady() {
  const conn = producer();
  if (conn.status === 'ready') return conn;
  await Promise.race([
    new Promise<void>((resolve) => conn.once('ready', resolve)),
    timeout(PRODUCER_TIMEOUT_MS),
  ]);
  return conn;
}

function queueFor(name: JobName, forWorker = false) {
  const key = (forWorker ? `worker:${name}` : name) as JobName;
  let queue = queues.get(key);
  if (!queue) {
    queue = new Queue(name, { connection: forWorker ? redis() : producer(), prefix: env.QUEUE_PREFIX });
    queue.on('error', (err) => logger.debug({ err: err.message, queue: name }, 'queue connection error'));
    queues.set(key, queue);
  }
  return queue;
}

async function run(name: JobName, envelope: unknown, jobId?: string) {
  const processor = processors.get(name);
  if (!processor) throw new Error(`No processor registered for job "${name}"`);
  const { _trace: parent, ...data } = (envelope ?? {}) as Envelope;
  const stop = jobDuration.startTimer({ queue: name });
  try {
    await withSpan(`process ${name}`, { kind: SpanKind.CONSUMER, parent, attributes: { ...jobAttributes(name, data), ...(jobId ? { 'messaging.message.id': jobId } : {}) } }, () =>
      processor(data as JobPayloads[JobName]),
    );
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
  try {
    await producerReady();
    await withSpan(`enqueue ${name}`, { kind: SpanKind.PRODUCER, attributes: jobAttributes(name, data) }, () =>
      Promise.race([
        // The carrier is taken inside the span, so the worker's span becomes its child.
        queueFor(name).add(name, { ...data, _trace: currentCarrier() } satisfies Envelope, {
          attempts: CONFIG[name].attempts,
          backoff: { type: 'exponential', delay: env.QUEUE_BACKOFF_MS },
          removeOnComplete: { age: 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
          ...options,
        }),
        timeout(PRODUCER_TIMEOUT_MS),
      ]),
    );
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'could not enqueue job');
    throw serviceUnavailable('The background job queue (Redis) is not reachable. Nothing was started; try again shortly.');
  }
}

/**
 * Started only by the worker process (src/worker.ts). `schedulers: false` leaves out the repeating
 * jobs, for callers that only want the on-demand queues served.
 */
export async function startWorkers({ schedulers = true }: { schedulers?: boolean } = {}) {
  const workers = (Object.keys(CONFIG) as JobName[]).map((name) => {
    const worker = new Worker(name, async (job) => run(name, job.data, job.id), { connection: redis(), concurrency: CONFIG[name].concurrency, prefix: env.QUEUE_PREFIX });
    worker.on('failed', (job, err) => logger.error({ err, queue: name, jobId: job?.id }, 'job failed'));
    worker.on('completed', (job) => logger.debug({ queue: name, jobId: job.id }, 'job completed'));
    return worker;
  });
  if (schedulers) {
    await queueFor('alert-eval', true).upsertJobScheduler('alert-eval-every-minute', { every: 60_000 }, { name: 'alert-eval', data: {} });
    await queueFor('log-retention', true).upsertJobScheduler('log-retention-hourly', { every: 3_600_000 }, { name: 'log-retention', data: {} });
  }
  logger.info({ queues: Object.keys(CONFIG) }, 'workers started');
  return async () => {
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
  };
}

export async function queueStats() {
  if (env.QUEUE_INLINE) return [];
  await producerReady();
  return Promise.race([
    Promise.all(
      (Object.keys(CONFIG) as JobName[]).map(async (name) => ({
        name,
        ...(await queueFor(name).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')),
      })),
    ),
    timeout(PRODUCER_TIMEOUT_MS),
  ]);
}

export async function redisPing(): Promise<boolean> {
  if (env.QUEUE_INLINE) return true;
  try {
    const conn = await producerReady();
    return (await Promise.race([conn.ping(), timeout(PRODUCER_TIMEOUT_MS)])) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await connection?.quit().catch(() => undefined);
  connection = undefined;
  producerConnection?.disconnect();
  producerConnection = undefined;
}
