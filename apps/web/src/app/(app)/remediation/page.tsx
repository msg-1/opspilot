'use client';

import { Bot, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { RemediationStatusBadge, RiskBadge } from '@/components/badges';
import { ProposeRemediation } from '@/components/propose-remediation';
import { Button, Card, EmptyState, ErrorState, Notice, PageHeader, Pagination, Spinner, Table, Tabs } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { timeAgo, titleCase } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Paged, Remediation, Service } from '@/lib/types';

type View = 'pending' | 'ready' | 'proposed' | 'history';
const FILTER: Record<View, string> = { pending: 'PENDING_APPROVAL', ready: 'APPROVED,EXECUTING,FAILED', proposed: 'PROPOSED', history: 'EXECUTED,REJECTED,CANCELLED' };

export default function RemediationPage() {
  const session = useSession();
  const [view, setView] = useState<View>('pending');
  const [page, setPage] = useState(1);
  const [proposing, setProposing] = useState(false);
  const { data, error, isLoading, refetch } = useApi<Paged<Remediation> & { statusCounts: Record<string, number>; executionMode: string }>(`/remediations${qs({ status: FILTER[view], page, pageSize: 20 })}`, { refetchInterval: 20_000, placeholderData: (p) => p });
  const services = useApi<Paged<Service>>(proposing ? '/services?pageSize=200' : null);
  const c = data?.statusCounts ?? {};
  const sum = (keys: string) => keys.split(',').reduce((a, k) => a + (c[k] ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Remediation approvals"
        description="Every production-changing action is proposed, approved by someone other than the requester, and only then executed by a person. The AI can propose actions; it can never approve or execute them."
        actions={session.can('remediation:propose') && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setProposing(true)}>Propose action</Button>}
      />
      {data && (
        <div className="mb-4">
          <Notice>{data.executionMode === 'webhook' ? 'Approved actions are dispatched to your remediation webhook when a person clicks Execute.' : 'No remediation webhook is configured: OPSILUME does not touch your infrastructure. After approval, an operator carries out the action and confirms it here. Configure a webhook under Settings to dispatch approved actions automatically.'}</Notice>
        </div>
      )}
      <Tabs
        value={view}
        onChange={(v) => { setView(v); setPage(1); }}
        tabs={[{ id: 'pending', label: 'Awaiting approval', count: sum(FILTER.pending) }, { id: 'ready', label: 'Approved, to execute', count: sum(FILTER.ready) }, { id: 'proposed', label: 'Proposals', count: sum(FILTER.proposed) }, { id: 'history', label: 'History', count: sum(FILTER.history) }]}
      />
      <Card padded={false}>
        {error ? <div className="p-4"><ErrorState error={error} retry={() => void refetch()} /></div> : isLoading || !data ? <Spinner /> : data.data.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="size-5" aria-hidden />}
            title={view === 'pending' ? 'Nothing is waiting for approval' : view === 'ready' ? 'No approved actions to execute' : view === 'proposed' ? 'No open proposals' : 'No completed actions yet'}
            description={view === 'proposed' ? 'Proposals come from AI investigations or from engineers. Submit one for approval to move it forward.' : undefined}
          />
        ) : (
          <>
            <Table head={<><th>Action</th><th>Status</th><th>Risk</th><th>Approvals</th><th>Incident</th><th>Proposed by</th><th>Created</th></>}>
              {data.data.map((r) => (
                <tr key={r.id} className="hover:bg-sunken/50">
                  <td className="max-w-[24rem]"><Link href={`/remediation/${r.id}`} className="block truncate font-medium hover:underline">{r.title}</Link><span className="text-[12px] text-ink-2">{titleCase(r.type)}{r.service ? ` · ${r.service.name}` : ''}</span></td>
                  <td><RemediationStatusBadge status={r.status} /></td>
                  <td><RiskBadge risk={r.risk} /></td>
                  <td className="tabular text-ink-2">{r.approvalsGranted}/{r.requiredApprovals}</td>
                  <td>{r.incident ? <Link href={`/incidents/${r.incident.id}`} className="font-mono text-[12.5px] hover:underline">INC-{r.incident.number}</Link> : <span className="text-ink-3">—</span>}</td>
                  <td className="whitespace-nowrap">{r.proposedByType === 'ai_agent' ? <span className="inline-flex items-center gap-1"><Bot className="size-3.5 text-accent" aria-hidden />OPSILUME AI</span> : r.proposedBy?.name}</td>
                  <td className="whitespace-nowrap text-ink-2">{timeAgo(r.createdAt)}</td>
                </tr>
              ))}
            </Table>
            <div className="border-t border-line"><Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} /></div>
          </>
        )}
      </Card>
      <ProposeRemediation open={proposing} onClose={() => setProposing(false)} services={services.data?.data ?? []} />
    </>
  );
}
