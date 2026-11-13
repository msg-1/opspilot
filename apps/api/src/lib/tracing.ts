import { type Attributes, type AttributeValue, context, propagation, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/**
 * Tracing helpers. Everything here goes through the OpenTelemetry API, which does nothing
 * unless src/telemetry.ts started an SDK (OTEL_ENABLED=true), so call sites need no checks.
 *
 * One investigation is one trace: the HTTP request that starts it, the queued job, the
 * worker, the AI service and every read-only tool call it makes back into this API.
 */
const tracer = trace.getTracer('opspilot');

/** The W3C trace context of the current span, in a form that can travel inside a job. */
export type TraceCarrier = Record<string, string>;

export function currentCarrier(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Continue the trace this carrier came from, instead of the current one. */
  parent?: TraceCarrier;
}

/** Runs `fn` inside a span, recording a failure on it and always ending it. */
export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
  const parent = options.parent ? propagation.extract(context.active(), options.parent) : context.active();
  return tracer.startActiveSpan(name, { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      // The error's class only: messages can carry what a user typed or what an upstream said.
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.name ?? 'Error' });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Adds attributes to the span of the request or job being handled, if there is one. Inside an
 * HTTP request that is the request's own span, not the framework layer that happens to be
 * running, so that a trace can be found by what its requests were about.
 */
export function annotate(attributes: Attributes) {
  const request = getRPCMetadata(context.active());
  (request?.type === RPCType.HTTP ? request.span : trace.getActiveSpan())?.setAttributes(attributes);
}

export const currentTraceId = () => trace.getActiveSpan()?.spanContext().traceId ?? null;

// ---- Scrubbing ---------------------------------------------------------------------------
// Spans leave the process, so they are held to the same rule as logs and audit metadata: no
// credentials and nothing that identifies a person. Instrumentation libraries decide most
// attribute names, which is why this is a filter on the way out and not a convention.
// contracts/fixtures/span-scrubbing.json holds the cases; the AI service implements the same.

const SENSITIVE_WORDS = new Set(['authorization', 'cookie', 'cookies', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'apikey', 'email', 'enduser', 'user', 'username']);
const ADDRESS_KEYS = new Set(['client.address', 'http.client_ip', 'net.peer.ip', 'net.sock.peer.addr', 'network.peer.address']);
const URL_KEYS = new Set(['url.full', 'http.url', 'http.target', 'url.path']);
const STATEMENT_KEYS = new Set(['db.statement', 'db.query.text']);
const TOKEN_IN_PATH = /(\/(?:invitations|reset|verify)\/)[^/?#]+/g;
const SECRET_IN_TEXT = /Bearer\s+[\w.~+/=-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|sk-ant-[\w-]+|opk_[\w-]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export const REDACTED = '[redacted]';

function sensitiveKey(key: string) {
  const words = key.toLowerCase().split(/[^a-z0-9]+/);
  return words.some((word, i) => (SENSITIVE_WORDS.has(word) && !(word === 'user' && words[i + 1] === 'agent')) || (word === 'api' && words[i + 1] === 'key'));
}

function scrubValue(key: string, value: AttributeValue): AttributeValue {
  if (typeof value !== 'string') return value;
  if (STATEMENT_KEYS.has(key)) return value.trim().split(/\s+/)[0] ?? '';
  const text = URL_KEYS.has(key) ? value.split(/[?#]/)[0]!.replace(TOKEN_IN_PATH, `$1${REDACTED}`) : value;
  return text.replace(SECRET_IN_TEXT, REDACTED);
}

export function scrubAttributes(attributes: Attributes): Attributes {
  const clean: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || key === 'url.query' || ADDRESS_KEYS.has(key) || sensitiveKey(key)) continue;
    clean[key] = scrubValue(key, value);
  }
  return clean;
}

/** Wraps an exporter so that nothing reaches it unscrubbed, whichever library made the span. */
export function scrubbingExporter(inner: SpanExporter): SpanExporter {
  const scrub = (span: ReadableSpan): ReadableSpan =>
    Object.create(span, {
      attributes: { value: scrubAttributes(span.attributes), enumerable: true },
      events: { value: span.events.map((event) => ({ ...event, attributes: event.attributes && scrubAttributes(event.attributes) })), enumerable: true },
    }) as ReadableSpan;
  return {
    export: (spans, done) => inner.export(spans.map(scrub), done),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}
