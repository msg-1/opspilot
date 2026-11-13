import { SpanStatusCode } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REPORT, aiStub, pause } from './faults';

// Tracing when tracing itself is broken, and tracing of work that fails. Three exporters receive
// every span: one in memory to read, one that throws, and the real OTLP exporter pointed at a
// port where nothing listens (a trace store that is not there). Jobs run in-process; that the
// trace context crosses the real queue is tested in tracing.test.ts.
const settings = vi.hoisted(() => {
  const aiPort = 21_000 + ((process.pid * 7 + 6 * 131) % 20_000);
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${aiPort}`;
  return { aiPort };
});

import { env } from '../src/config/env';
import { scrubbingExporter, withSpan } from '../src/lib/tracing';
import { createOrg } from './helpers';

const QUESTION = 'Why did checkout start failing for ada@example.com?';
const ai = aiStub(settings.aiPort);
const memory = new InMemorySpanExporter();
const broken = { exports: 0 };
const throwing: SpanExporter = {
  export: () => {
    broken.exports += 1;
    throw new Error('exporter exploded');
  },
  shutdown: async () => undefined,
};
const unreachable = new OTLPTraceExporter({ url: 'http://127.0.0.1:9/v1/traces', timeoutMillis: 500 });
const sdk = new NodeSDK({
  serviceName: 'opspilot-test',
  autoDetectResources: false,
  instrumentations: [],
  spanProcessors: [new SimpleSpanProcessor({ exporter: scrubbingExporter(memory) }), new SimpleSpanProcessor({ exporter: scrubbingExporter(throwing) }), new SimpleSpanProcessor({ exporter: scrubbingExporter(unreachable) })],
});

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled);
  sdk.start();
  await ai.start();
});
beforeEach(() => {
  ai.reset();
  memory.reset();
  env.INVESTIGATION_TIMEOUT_MS = 15 * 60_000;
});
afterAll(async () => {
  await ai.stop();
  await sdk.shutdown().catch(() => undefined);
  process.off('unhandledRejection', onUnhandled);
});

const spanNamed = (name: string) => {
  const span = memory.getFinishedSpans().find((s) => s.name === name);
  expect(span, `span "${name}" was not recorded`).toBeDefined();
  return span!;
};
const everythingExported = () => JSON.stringify(memory.getFinishedSpans().map((s) => [s.name, s.attributes, s.status, s.events.map((e) => [e.name, e.attributes])]));

describe('tracing when the trace store is missing or the exporter fails', () => {
  it('does not change the result of the work being traced', async () => {
    await expect(withSpan('work', {}, async () => 42)).resolves.toBe(42);
    await expect(withSpan('work', {}, async () => Promise.reject(new RangeError('original failure')))).rejects.toThrow('original failure');
    expect(broken.exports).toBeGreaterThanOrEqual(2);
  });

  it('lets an investigation run to a stored report', async () => {
    const org = await createOrg();
    const before = broken.exports;
    const started = await org.owner.post('/api/v1/investigations').send({ question: QUESTION }).expect(202);
    const done = (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', report: expect.objectContaining({ summary: EMPTY_REPORT.summary }) });
    // The broken exporters were really in the path of every span of that run.
    expect(broken.exports - before).toBeGreaterThanOrEqual(4);
    for (const name of ['process investigation', 'investigation.run', 'investigation.guardrails', 'investigation.persist']) spanNamed(name);
    // Give the failed network export time to settle: it must not surface as an unhandled rejection.
    await pause(900);
    expect(unhandled).toEqual([]);
  });
});

describe('tracing of work that fails', () => {
  it.each([
    ['the AI service answers with an error', () => void (ai.state.onRun = (_req, res) => void res.writeHead(500).end('engine crashed: prompt was "tell me about ada@example.com"')), 'AppError', 'AI service returned 500'],
    ['the AI service is not there', async () => ai.stop(), 'AppError', 'not reachable'],
    ['the time limit passes', () => ((env.INVESTIGATION_TIMEOUT_MS = 300), void (ai.state.onRun = () => undefined)), 'Error', 'did not finish within'],
  ])('%s: the span of the run is marked failed by error class, and the failure is on the record', async (_name, arrange, errorClass, message) => {
    const org = await createOrg();
    await arrange();
    try {
      const started = await org.owner.post('/api/v1/investigations').send({ question: QUESTION }).expect(202);
      const failed = (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain(message);

      const run = spanNamed('investigation.run');
      expect(run.status).toEqual({ code: SpanStatusCode.ERROR, message: errorClass });
      expect(run.attributes['opspilot.investigation.id']).toBe(started.body.id);
      // The run failed; the job that carried it did its work (it recorded the failure) and is not marked failed.
      const job = spanNamed('process investigation');
      expect(job.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(run.spanContext().traceId).toBe(job.spanContext().traceId);
      // No report was stored, so there are no spans claiming one was.
      expect(memory.getFinishedSpans().map((s) => s.name)).not.toContain('investigation.persist');
      // Ids and classes only: not the question, not the upstream's text, not the failure message.
      const exported = everythingExported();
      for (const secret of ['ada@example.com', 'checkout', 'engine crashed', 'not reachable', 'did not finish']) expect(exported).not.toContain(secret);
    } finally {
      await ai.start();
    }
  });
});
