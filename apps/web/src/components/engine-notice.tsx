import { Cog, Cpu, FlaskConical } from 'lucide-react';
import { Mono, Notice } from './ui';

export interface AiStatus {
  reachable: boolean;
  detail?: string;
  llm?: {
    provider: string;
    configuredProvider?: string;
    model: string | null;
    available: boolean;
    detail: string;
    verification?: { ok: boolean; detail: string } | null;
    credentials?: { anthropic: boolean; openai: boolean };
    limits?: { maxOutputTokensPerCall: number; requestTimeoutSeconds: number; maxRetries: number; maxCostUsdPerInvestigation: number; maxTokensPerInvestigation: number };
  };
  embeddings?: { provider: string; model: string };
  usageToday?: { investigations: number; running: number; estimatedCostUsd: number; tokens: number };
  organizationLimits?: { maxConcurrent: number; dailyInvestigations: number; dailyCostUsd: number };
}

const NAMES: Record<string, string> = { anthropic: 'Claude (Anthropic API)', openai: 'OpenAI', ollama: 'Ollama (local)' };

/** States which engine the next investigation will use, before the user spends anything. */
export function EngineNotice({ status }: { status: AiStatus | undefined }) {
  if (!status) return null;
  if (!status.reachable) return <Notice tone="warn"><strong>The AI service is not reachable.</strong> Investigations will fail until it is running ({status.detail}).</Notice>;
  const { llm, usageToday: used, organizationLimits: org } = status;
  if (llm?.provider === 'mock') {
    return <Notice tone="warn"><span className="inline-flex items-start gap-1.5"><FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span><strong>Mock AI is active.</strong> Investigations run a scripted stand-in and call no model. Results are placeholders, labelled as mock. Set AI_PROVIDER to anthropic or deterministic for real analysis.</span></span></Notice>;
  }
  if (llm?.available) {
    return (
      <Notice>
        <span className="inline-flex items-start gap-1.5">
          <Cpu className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Real model inference by <strong>{NAMES[llm.provider] ?? llm.provider}</strong> · <Mono>{llm.model}</Mono>. Evidence retrieved from your organisation is sent to this provider, and each investigation uses paid API credit.
            {llm.limits && used && org && (
              <span className="mt-1 block text-[12px]">
                Limits: ${llm.limits.maxCostUsdPerInvestigation.toFixed(2)} per investigation, ${org.dailyCostUsd.toFixed(2)} per day. Today: {used.investigations} investigation{used.investigations === 1 ? '' : 's'}, estimated ${used.estimatedCostUsd.toFixed(4)}.
              </span>
            )}
          </span>
        </span>
      </Notice>
    );
  }
  const wanted = llm?.configuredProvider && llm.configuredProvider !== 'none';
  return (
    <Notice tone={wanted ? 'warn' : 'info'}>
      <span className="inline-flex items-start gap-1.5">
        <Cog className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span><strong>{wanted ? `${NAMES[llm?.configuredProvider ?? ''] ?? llm?.configuredProvider} is configured but not usable.` : 'No AI model is in use.'}</strong> Investigations run on the rule-based engine: it gathers the same evidence and correlates it by timing and keyword overlap, but does not reason about it. {llm?.detail}</span>
      </span>
    </Notice>
  );
}
