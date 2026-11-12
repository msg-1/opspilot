import { Cpu } from 'lucide-react';
import { Mono, Notice } from './ui';

export interface AiStatus {
  reachable: boolean;
  detail?: string;
  llm?: { provider: string; model: string | null; available: boolean; detail: string };
  embeddings?: { provider: string; model: string };
}

export function EngineNotice({ status }: { status: AiStatus | undefined }) {
  if (!status) return null;
  if (!status.reachable) return <Notice tone="warn"><strong>The AI service is not reachable.</strong> Investigations will fail until it is running ({status.detail}).</Notice>;
  if (status.llm?.available) {
    return <Notice><span className="inline-flex items-center gap-1.5"><Cpu className="size-3.5" aria-hidden />Analysis by <strong>{status.llm.provider}</strong> · <Mono>{status.llm.model}</Mono>. Tool results from your organisation are sent to this provider.</span></Notice>;
  }
  return <Notice tone="warn"><strong>No language model is configured.</strong> Investigations run with the built-in rule-based engine: it gathers the same evidence and correlates it by timing and keyword overlap, but cannot reason about code. {status.llm?.detail}</Notice>;
}

