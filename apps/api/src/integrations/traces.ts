import { env } from '../config/env';

/**
 * Reads distributed traces from a Jaeger-compatible query API (Jaeger itself, or anything that
 * serves /api/traces in Jaeger's JSON format). OpsPilot does not store traces: it asks the trace
 * store at investigation time and summarises what comes back.
 *
 * The trace store is configured by the operator (TRACES_URL) and is not tenant-aware, so callers
 * must first check that the service belongs to the caller's organisation. Services are looked up
 * by their slug, which is expected to be the service's OpenTelemetry service.name.
 */

export interface TraceSummary {
  traceId: string;
  startedAt: string;
  durationMs: number;
  rootService: string;
  rootOperation: string;
  spanCount: number;
  services: string[];
  /** The span with the largest self time: where the trace actually spent its time. */
  slowestSpan: { service: string; operation: string; durationMs: number; selfMs: number; system: string | null; peer: string | null } | null;
  errorSpans: { service: string; operation: string; message: string | null; system: string | null; peer: string | null }[];
}

export interface TraceResult {
  available: boolean;
  note: string | null;
  sampled: number;
  failed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  traces: TraceSummary[];
}

interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references?: { refType: string; spanID: string }[];
  startTime: number; // microseconds
  duration: number; // microseconds
  tags?: { key: string; value: unknown }[];
  logs?: { fields?: { key: string; value: unknown }[] }[];
  processID: string;
}
interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
}

const ms = (micros: number) => Math.round(micros / 10) / 100;
const tag = (span: JaegerSpan, key: string) => span.tags?.find((t) => t.key === key)?.value;

function failed(span: JaegerSpan) {
  const status = Number(tag(span, 'http.status_code') ?? tag(span, 'http.response.status_code') ?? 0);
  return tag(span, 'error') === true || tag(span, 'error') === 'true' || tag(span, 'otel.status_code') === 'ERROR' || status >= 500;
}

function errorMessage(span: JaegerSpan): string | null {
  const direct = tag(span, 'otel.status_description') ?? tag(span, 'exception.message') ?? tag(span, 'error.message');
  if (typeof direct === 'string' && direct) return direct.slice(0, 200);
  for (const log of span.logs ?? []) {
    const message = log.fields?.find((f) => f.key === 'exception.message' || f.key === 'message')?.value;
    if (typeof message === 'string' && message) return message.slice(0, 200);
  }
  const status = tag(span, 'http.status_code') ?? tag(span, 'http.response.status_code');
  return status ? `HTTP ${String(status)}` : null;
}

/** What kind of call a span is (postgresql, redis, http) and whom it was made to, when the span says. */
function target(span: JaegerSpan): { system: string | null; peer: string | null } {
  // Both the older and the current OpenTelemetry attribute names are read.
  const system = tag(span, 'db.system.name') ?? tag(span, 'db.system') ?? (tag(span, 'http.method') || tag(span, 'http.request.method') ? 'http' : null);
  const peer = tag(span, 'peer.service') ?? tag(span, 'net.peer.name') ?? tag(span, 'server.address') ?? null;
  return { system: typeof system === 'string' ? system : null, peer: typeof peer === 'string' ? peer : null };
}

export function summarise(trace: JaegerTrace): TraceSummary | null {
  if (!trace.spans?.length) return null;
  const ids = new Set(trace.spans.map((s) => s.spanID));
  const parentOf = (s: JaegerSpan) => s.references?.find((r) => r.refType === 'CHILD_OF' && ids.has(r.spanID))?.spanID;
  const root = trace.spans.filter((s) => !parentOf(s)).sort((a, b) => a.startTime - b.startTime)[0] ?? trace.spans[0]!;
  const service = (s: JaegerSpan) => trace.processes[s.processID]?.serviceName ?? 'unknown';
  const childTime = new Map<string, number>();
  for (const s of trace.spans) {
    const parent = parentOf(s);
    if (parent) childTime.set(parent, (childTime.get(parent) ?? 0) + s.duration);
  }
  // Self time: a span's own duration minus the time spent in its children. Concurrent children
  // can exceed the parent, so it is floored at zero.
  const withSelf = trace.spans.map((s) => ({ span: s, self: Math.max(0, s.duration - (childTime.get(s.spanID) ?? 0)) }));
  const slowest = withSelf.sort((a, b) => b.self - a.self)[0];
  return {
    traceId: trace.traceID,
    startedAt: new Date(root.startTime / 1000).toISOString(),
    durationMs: ms(root.duration),
    rootService: service(root),
    rootOperation: root.operationName,
    spanCount: trace.spans.length,
    services: [...new Set(trace.spans.map(service))].sort(),
    slowestSpan: slowest ? { service: service(slowest.span), operation: slowest.span.operationName, durationMs: ms(slowest.span.duration), selfMs: ms(slowest.self), ...target(slowest.span) } : null,
    errorSpans: trace.spans.filter(failed).slice(0, 5).map((s) => ({ service: service(s), operation: s.operationName, message: errorMessage(s), ...target(s) })),
  };
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export const tracesConfig = { url: env.TRACES_URL };
const SETTLE_MS = 8000;
const SLICES = 4;
const PER_SLICE = 60;

export async function queryTraces(serviceName: string, from: Date, to: Date, opts: { limit?: number; errorsOnly?: boolean } = {}): Promise<TraceResult> {
  const none = (note: string): TraceResult => ({ available: false, note, sampled: 0, failed: 0, p50Ms: null, p95Ms: null, traces: [] });
  if (!tracesConfig.url) return none('No trace store is connected (TRACES_URL is not set).');
  // Spans reach the store in batches, a few seconds after they end. A trace that began in the
  // last moments may still be missing spans, and summarising it would misplace its time.
  const settled = Date.now() - SETTLE_MS;
  const end = Math.min(to.getTime(), settled);
  if (end <= from.getTime()) return { available: true, note: 'The window is too recent: its traces may not have reached the trace store yet.', sampled: 0, failed: 0, p50Ms: null, p95Ms: null, traces: [] };
  // A trace store returns the most recent traces first, so one query with a limit sees only the
  // end of the window (the last ten seconds, at a few requests per second). The window is cut
  // into slices and each is sampled, so that the sample covers all of it.
  const width = (end - from.getTime()) / SLICES;
  const slice = async (index: number): Promise<JaegerTrace[]> => {
    const url = new URL('/api/traces', tracesConfig.url);
    const start = from.getTime() + index * width;
    url.search = new URLSearchParams({
      service: serviceName, start: String(Math.round(start * 1000)), end: String(Math.round((start + width) * 1000)), limit: String(PER_SLICE), lookback: 'custom',
      ...(opts.errorsOnly ? { tags: JSON.stringify({ error: 'true' }) } : {}),
    }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { data?: JaegerTrace[] }).data ?? [];
  };
  let traces: JaegerTrace[];
  try {
    traces = (await Promise.all(Array.from({ length: SLICES }, (_, i) => slice(i)))).flat();
  } catch (err) {
    return none(`The trace store could not be queried: ${(err as Error).message}`);
  }
  const seen = new Set<string>();
  const all = traces
    .filter((t) => !seen.has(t.traceID) && seen.add(t.traceID))
    .map(summarise)
    .filter((t): t is TraceSummary => !!t && t.services.includes(serviceName) && new Date(t.startedAt).getTime() + t.durationMs < settled);
  const durations = all.map((t) => t.durationMs).sort((a, b) => a - b);
  const failedCount = all.filter((t) => t.errorSpans.length).length;
  // Failed traces first, then the slowest: the ones worth reading.
  const ranked = all.filter((t) => !opts.errorsOnly || t.errorSpans.length).sort((a, b) => Number(b.errorSpans.length > 0) - Number(a.errorSpans.length > 0) || b.durationMs - a.durationMs);
  return {
    available: true,
    note: all.length ? null : 'The trace store holds no traces for this service in the window.',
    sampled: all.length,
    failed: failedCount,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    traces: ranked.slice(0, Math.min(opts.limit ?? 6, 20)),
  };
}
