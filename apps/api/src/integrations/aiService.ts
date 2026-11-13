import { env } from '../config/env';
import { serviceUnavailable } from '../lib/errors';

/**
 * Client for the Python AI service (services/ai). The API never talks to an LLM directly:
 * embeddings and investigations go through this boundary.
 */

export interface AiStatus {
  llm: { provider: string; model: string | null; available: boolean; detail?: string };
  embeddings: { provider: string; model: string; dimensions: number };
}

export interface EmbeddingResult {
  provider: string;
  model: string;
  dimensions: number;
  vectors: number[][];
}

export type InvestigationEvent =
  | { type: 'meta'; provider: string; model: string | null }
  | {
      type: 'step';
      step: { type: string; title: string; detail?: string | null; toolName?: string | null; input?: unknown; output?: unknown; status?: string; durationMs?: number | null };
    }
  | {
      type: 'evidence';
      evidence: { ref: string; kind: string; title: string; summary: string; sourceType?: string | null; sourceId?: string | null; occurredAt?: string | null; relevance?: number | null; data?: unknown };
    }
  | { type: 'final'; report: unknown; usage?: InvestigationUsage; engine?: { mode: string; provider: string; model: string | null; attemptedProvider: string | null } }
  | { type: 'error'; message: string };

export interface InvestigationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  llmCalls?: number;
  llmLatencyMs?: number;
  estimatedCostUsd?: number | null;
}

export interface InvestigationRequest {
  investigationId: string;
  question: string;
  organizationName: string;
  apiUrl: string;
  toolToken: string;
  incident?: unknown;
  timeWindow?: { from: string; to: string };
  serviceHints?: string[];
}

const headers = () => ({ 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_SERVICE_TOKEN });

async function call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.AI_SERVICE_URL}${path}`, {
      ...init,
      headers: { ...headers(), ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw serviceUnavailable(`AI service is not reachable at ${env.AI_SERVICE_URL} (${(err as Error).message})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw serviceUnavailable(`AI service returned ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const aiService = {
  status: (verify = false) => call<AiStatus>(`/v1/status${verify ? '?verify=true' : ''}`, { timeoutMs: verify ? 15_000 : 5000 }),

  embed: (texts: string[], kind: 'document' | 'query') =>
    call<EmbeddingResult>('/v1/embeddings', { method: 'POST', body: JSON.stringify({ texts, kind }), timeoutMs: 120_000 }),

  /**
   * Streams NDJSON events from the investigation agent until it finishes.
   *
   * Each way the stream can go wrong has its own message, none of which repeats what was
   * received: a timeout, a connection that ends early, and a line that is not an event are
   * different failures and are reported as such. An error thrown by `onEvent` passes through
   * untouched. When `signal` aborts, its reason is what is thrown.
   */
  async runInvestigation(request: InvestigationRequest, onEvent: (event: InvestigationEvent) => Promise<void>, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(env.INVESTIGATION_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const transport = (err: unknown, otherwise: () => Error) => {
      if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : (err as Error);
      if (deadline.aborted) return new Error(`The investigation did not finish within ${describeMs(env.INVESTIGATION_TIMEOUT_MS)} and was stopped. No conclusions were recorded.`);
      return otherwise();
    };
    let res: Response;
    try {
      res = await fetch(`${env.AI_SERVICE_URL}/v1/investigations/run`, { method: 'POST', headers: headers(), body: JSON.stringify(request), signal: combined });
    } catch (err) {
      throw transport(err, () => serviceUnavailable(`AI service is not reachable at ${env.AI_SERVICE_URL} (${(err as Error).message})`));
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw serviceUnavailable(`AI service returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const interrupted = () => new Error('The connection to the AI service was interrupted before the investigation finished. No conclusions were recorded.');
    const parse = (line: string): InvestigationEvent | null => {
      try {
        const event = JSON.parse(line) as unknown;
        return event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string' ? (event as InvestigationEvent) : null;
      } catch {
        return null;
      }
    };
    const dispatch = async (line: string) => {
      const event = parse(line);
      // The parser's own message quotes the input, which may be model output. It is not repeated.
      if (!event) throw new Error('The AI service sent a line that is not a valid event. The investigation was stopped; no conclusions were recorded.');
      await onEvent(event);
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw transport(err, interrupted);
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) await dispatch(line);
        }
      }
      // Every event ends with a newline. What is left over is either a last event without one,
      // or the beginning of an event that never arrived in full: the stream was cut.
      const rest = buffer.trim();
      if (rest) {
        const last = parse(rest);
        if (!last) throw transport(undefined, interrupted);
        await onEvent(last);
      }
    } finally {
      // Stop the AI service from working on a run nobody is listening to any more.
      await reader.cancel().catch(() => undefined);
    }
  },
};

const describeMs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`);
