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
  | { type: 'final'; report: unknown; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; message: string };

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
  status: () => call<AiStatus>('/v1/status', { timeoutMs: 5000 }),

  embed: (texts: string[], kind: 'document' | 'query') =>
    call<EmbeddingResult>('/v1/embeddings', { method: 'POST', body: JSON.stringify({ texts, kind }), timeoutMs: 120_000 }),

  /** Streams NDJSON events from the investigation agent until it finishes. */
  async runInvestigation(request: InvestigationRequest, onEvent: (event: InvestigationEvent) => Promise<void>, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await fetch(`${env.AI_SERVICE_URL}/v1/investigations/run`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) : AbortSignal.timeout(15 * 60_000),
      });
    } catch (err) {
      throw serviceUnavailable(`AI service is not reachable at ${env.AI_SERVICE_URL} (${(err as Error).message})`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw serviceUnavailable(`AI service returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) await onEvent(JSON.parse(line) as InvestigationEvent);
      }
    }
    if (buffer.trim()) await onEvent(JSON.parse(buffer) as InvestigationEvent);
  },
};
