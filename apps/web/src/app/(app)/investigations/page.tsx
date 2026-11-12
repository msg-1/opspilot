'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfidenceMeter, EngineBadge, InvestigationStatusBadge, OutcomeBadge } from '@/components/badges';
import { type AiStatus, EngineNotice } from '@/components/engine-notice';
import { Button, Card, EmptyState, ErrorState, FormError, PageHeader, Pagination, Select, Spinner, Textarea } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Incident, InvestigationSummary, Paged } from '@/lib/types';

const EXAMPLES = [
  'Why did error rates rise on checkout-service in the last 2 hours?',
  'Did any deployment in the last 24 hours change database connection settings?',
  'Is anything unusual happening on payment-service right now?',
];

export default function InvestigationsPage() {
  const session = useSession();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [question, setQuestion] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const { run, busy, error } = useAction();
  const canRun = session.can('investigation:run');
  const list = useApi<Paged<InvestigationSummary>>(`/investigations${qs({ page, pageSize: 15 })}`, { refetchInterval: 10_000, placeholderData: (p) => p });
  const status = useApi<AiStatus>('/investigations/ai-status', { staleTime: 15_000 });
  const incidents = useApi<Paged<Incident>>(canRun ? '/incidents?active=true&pageSize=50' : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const created = await run(() => api.post<{ id: string }>('/investigations', { question, ...(incidentId ? { incidentId } : {}) }));
    if (created) router.push(`/investigations/${created.id}`);
  }

  return (
    <>
      <PageHeader title="Investigations" description="Ask a question in plain language. OPSILUME plans the investigation, queries your logs, deployments, code changes, metrics and knowledge base, and returns ranked hypotheses with the evidence behind each one." />
      <div className="mb-4"><EngineNotice status={status.data} /></div>

      {canRun && (
        <Card className="mb-4">
          <form onSubmit={submit}>
            <FormError error={error} />
            <Textarea aria-label="Investigation question" rows={3} required minLength={8} maxLength={4000} placeholder="What do you want to find out?" value={question} onChange={(e) => setQuestion(e.target.value)} className="text-[15px]" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setQuestion(ex)} className="rounded-full border border-line bg-sunken/60 px-2.5 py-1 text-[12px] text-ink-2 hover:border-line-strong hover:text-ink">{ex}</button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Select aria-label="Link to an incident" className="w-72 max-w-full" value={incidentId} onChange={(e) => setIncidentId(e.target.value)}>
                <option value="">Not linked to an incident</option>
                {incidents.data?.data.map((i) => <option key={i.id} value={i.id}>{i.key} · {i.title.slice(0, 50)}</option>)}
              </Select>
              <Button type="submit" variant="primary" loading={!!busy} disabled={question.trim().length < 8} icon={<Sparkles className="size-4" aria-hidden />}>Investigate</Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="History" padded={false}>
        {list.error ? <div className="p-4"><ErrorState error={list.error} retry={() => void list.refetch()} /></div> : list.isLoading || !list.data ? <Spinner /> : list.data.data.length === 0 ? (
          <EmptyState icon={<Sparkles className="size-5" aria-hidden />} title="No investigations yet" description="Every investigation is saved here with its plan, the tools it called, the evidence it found and its conclusions." />
        ) : (
          <>
            <ul>
              {list.data.data.map((i) => (
                <li key={i.id} className="border-b border-line last:border-0">
                  <Link href={`/investigations/${i.id}`} className="block px-4 py-3 hover:bg-sunken/50">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.question}</span>
                      <InvestigationStatusBadge status={i.status} />
                    </div>
                    {i.summary && <p className="mt-1 line-clamp-2 max-w-4xl text-[13px] text-ink-2">{i.summary}</p>}
                    {i.error && <p className="mt-1 text-[13px] text-critical-ink">{i.error}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
                      {i.outcome && <OutcomeBadge outcome={i.outcome} />}
                      {i.confidence !== null && i.outcome !== 'HEALTHY' && i.outcome !== 'UNDETERMINED' && <ConfidenceMeter value={i.confidence} />}
                      {i.incident && <span>INC-{i.incident.number}</span>}
                      <span>{i._count?.evidence ?? 0} evidence · {i._count?.hypotheses ?? 0} hypotheses</span>
                      <EngineBadge mode={i.analysisMode} provider={i.provider} model={i.model} attemptedProvider={i.attemptedProvider} />
                      {!!i.estimatedCostUsd && <span className="tabular">${i.estimatedCostUsd.toFixed(4)}</span>}
                      <span>{timeAgo(i.createdAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-line"><Pagination page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={setPage} /></div>
          </>
        )}
      </Card>
    </>
  );
}
