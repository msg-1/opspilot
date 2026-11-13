import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Attributes, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InvestigationEvent } from '../src/integrations/aiService';

// Tracing across the queue, on real BullMQ and Redis like tests/queue.test.ts: the worker's
// spans must join the trace of the request that enqueued the job, and nothing sensitive may
// be exported. Spans are collected in memory; nothing is sent anywhere.
const settings = vi.hoisted(() => {
  const prefix = `opspilot-trace-test-${process.pid}-${Date.now()}`;
  process.env.QUEUE_INLINE = 'false';
  process.env.QUEUE_PREFIX = prefix;
  return { prefix, redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379' };
});

const QUESTION = 'Why did checkout start failing for ada@example.com?';
const report = { summary: 'Nothing conclusive was found.', confidence: 0.1, analysisMode: 'heuristic', timeline: [], facts: [], assumptions: [], uncertainties: [], hypotheses: [], nextSteps: [], recommendedActions: [] };

vi.mock('../src/integrations/aiService', () => ({
  aiService: {
    status: async () => ({ llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'unit', dimensions: 768 } }),
    embed: async (texts: string[]) => ({ provider: 'test', model: 'unit', dimensions: 768, vectors: texts.map(() => [1, ...new Array(767).fill(0)]) }),
    runInvestigation: async (_request: never, onEvent: (e: InvestigationEvent) => Promise<void>) => {
      await onEvent({ type: 'final', report } as InvestigationEvent);
    },
  },
}));

import { REDACTED, scrubAttributes, scrubbingExporter, withSpan } from '../src/lib/tracing';
import { closeQueues, startWorkers } from '../src/queues';
import { createOrg } from './helpers';

const memory = new InMemorySpanExporter();
const sdk = new NodeSDK({ serviceName: 'opspilot-test', autoDetectResources: false, instrumentations: [], spanProcessors: [new SimpleSpanProcessor({ exporter: scrubbingExporter(memory) })] });

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
if (!redisAvailable && process.env.CI) throw new Error(`Tracing tests need Redis at ${settings.redisUrl}`);

beforeAll(() => sdk.start());
afterAll(async () => {
  await closeQueues();
  await sdk.shutdown();
  if (redisAvailable) {
    const redis = new IORedis(settings.redisUrl);
    const keys = await redis.keys(`${settings.prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
});

describe('span scrubbing', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../contracts/fixtures/span-scrubbing.json'), 'utf8')) as { cases: { name: string; attributes: Attributes; expected: Attributes }[] };

  it.each(fixture.cases)('$name', ({ attributes, expected }) => {
    expect(scrubAttributes(attributes)).toEqual(expected);
  });

  it('is applied to every exported span and its events, whoever created them', async () => {
    memory.reset();
    await withSpan('lookup', { attributes: { 'http.request.header.authorization': 'Bearer abc', 'url.full': 'http://api:4000/api/v1/logs?q=secret+words', 'opspilot.tool.name': 'search_logs' } }, async (span) => {
      span.addEvent('exception', { 'exception.message': 'rejected ada@example.com' });
    });
    const [span] = memory.getFinishedSpans();
    expect(span!.attributes).toEqual({ 'url.full': 'http://api:4000/api/v1/logs', 'opspilot.tool.name': 'search_logs' });
    expect(span!.events[0]!.attributes).toEqual({ 'exception.message': `rejected ${REDACTED}` });
    // Identity of the span survives the wrapping.
    expect(span!.name).toBe('lookup');
    expect(span!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('records a failure by its class, never by its message', async () => {
    memory.reset();
    await expect(withSpan('work', {}, async () => Promise.reject(new TypeError('token sk-ant-api03-zzz was refused')))).rejects.toThrow('refused');
    const [span] = memory.getFinishedSpans();
    expect(span!.status).toEqual({ code: SpanStatusCode.ERROR, message: 'TypeError' });
  });
});

describe.skipIf(!redisAvailable)('one investigation, one trace (BullMQ on Redis)', () => {
  it('the worker continues the trace of the request that queued the job, with ids and nothing else', async () => {
    const org = await createOrg();
    memory.reset();
    const started = await org.owner.post('/api/v1/investigations').send({ question: QUESTION });
    expect(started.status).toBe(202);
    const id = started.body.id as string;

    const stop = await startWorkers({ schedulers: false });
    try {
      await vi.waitFor(async () => expect((await org.owner.get(`/api/v1/investigations/${id}`)).body.status).toBe('COMPLETED'), { timeout: 10_000, interval: 50 });
      await vi.waitFor(() => expect(memory.getFinishedSpans().map((s) => s.name)).toContain('process investigation'), { timeout: 5000 });
    } finally {
      await stop();
    }

    const spans = memory.getFinishedSpans();
    const named = (name: string) => {
      const span = spans.find((s) => s.name === name);
      expect(span, `span "${name}" was not recorded`).toBeDefined();
      return span!;
    };
    const enqueue = named('enqueue investigation');
    const job = named('process investigation');
    const run = named('investigation.run');
    const guardrails = named('investigation.guardrails');
    const persist = named('investigation.persist');

    // One trace, and the right shape: producer -> consumer -> run -> guardrails, persist.
    const traceId = enqueue.spanContext().traceId;
    for (const span of [job, run, guardrails, persist]) expect(span.spanContext().traceId).toBe(traceId);
    expect(job.parentSpanContext?.spanId).toBe(enqueue.spanContext().spanId);
    expect(run.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
    expect(guardrails.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(persist.parentSpanContext?.spanId).toBe(run.spanContext().spanId);

    // Found by the investigation's id, which is all a span says about the work.
    expect(enqueue.attributes['opspilot.investigation.id']).toBe(id);
    expect(job.attributes).toMatchObject({ 'opspilot.investigation.id': id, 'messaging.destination.name': 'investigation', 'messaging.system': 'bullmq' });
    expect(run.attributes).toMatchObject({ 'opspilot.engine.mode': 'heuristic' });

    // Neither the question, nor who asked, nor any credential is in what was exported.
    const exported = JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status })));
    for (const forbidden of ['checkout start failing', '@example.com', 'Olivia', 'Bearer', 'traceparent']) expect(exported).not.toContain(forbidden);
  });
});
