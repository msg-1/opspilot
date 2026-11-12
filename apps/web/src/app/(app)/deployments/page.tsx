'use client';

import clsx from 'clsx';
import { Plus, Rocket, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { DeploymentStatusBadge } from '@/components/badges';
import { Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, Mono, PageHeader, Pagination, Select, Spinner, Table, Textarea } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Deployment, Paged, ServiceRef } from '@/lib/types';

function RecordForm({ onClose, services }: { onClose: () => void; services: ServiceRef[] }) {
  const { run, busy, error } = useAction();
  const [f, setF] = useState({ service: services[0]?.slug ?? '', version: '', environment: 'production', status: 'SUCCEEDED', commitSha: '', description: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title="Record a deployment" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="deploy" loading={!!busy}>Record</Button></>}>
      <form id="deploy" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/deployments', { ...f, commitSha: f.commitSha || null, description: f.description || null }))) onClose(); }}>
        <p className="text-[13px] text-ink-2">This records that a deployment happened; it does not deploy anything. Normally your CI/CD pipeline sends this automatically.</p>
        <FormError error={error} />
        <Field label="Service">{(id) => <Select id={id} required value={f.service} onChange={set('service')}>{services.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Version">{(id) => <Input id={id} required value={f.version} onChange={set('version')} placeholder="v2.14.0" />}</Field>
          <Field label="Commit SHA">{(id) => <Input id={id} minLength={7} value={f.commitSha} onChange={set('commitSha')} placeholder="optional" />}</Field>
          <Field label="Environment">{(id) => <Input id={id} required value={f.environment} onChange={set('environment')} />}</Field>
          <Field label="Outcome">{(id) => <Select id={id} value={f.status} onChange={set('status')}><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed</option><option value="IN_PROGRESS">In progress</option></Select>}</Field>
        </div>
        <Field label="What changed">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={set('description')} />}</Field>
      </form>
    </Modal>
  );
}

function DeploymentsPage() {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const service = params.get('service') ?? '';
  const highlight = params.get('highlight');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const facets = useApi<{ services: ServiceRef[] }>('/logs/facets', { staleTime: 60_000 });
  const { data, error, isLoading, refetch } = useApi<Paged<Deployment>>(`/deployments${qs({ service, status, page, pageSize: 25 })}`, { refetchInterval: 30_000, placeholderData: (p) => p });

  return (
    <>
      <PageHeader title="Deployments" description="Every release, in order. Investigations use this history to find what changed before a problem started." actions={session.can('deployment:write') && !!facets.data?.services.length && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Record deployment</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Service" className="w-56" value={service} onChange={(e) => { setPage(1); router.replace(e.target.value ? `/deployments?service=${e.target.value}` : '/deployments'); }}>
          <option value="">All services</option>
          {facets.data?.services.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
        </Select>
        <Select aria-label="Outcome" className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Any outcome</option><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed</option><option value="ROLLED_BACK">Rolled back</option><option value="IN_PROGRESS">In progress</option>
        </Select>
      </div>
      <Card padded={false}>
        {error ? <div className="p-4"><ErrorState error={error} retry={() => void refetch()} /></div> : isLoading || !data ? <Spinner /> : data.data.length === 0 ? (
          <EmptyState icon={<Rocket className="size-5" aria-hidden />} title="No deployments recorded" description={<>Have your pipeline POST to <Mono>/api/v1/deployments</Mono> after each release, using an API key with the <Mono>ingest:deployments</Mono> scope.</>} />
        ) : (
          <>
            <Table head={<><th>Service</th><th>Version</th><th>Outcome</th><th>Environment</th><th>Commit</th><th>What changed</th><th>By</th><th>When</th></>}>
              {data.data.map((d) => (
                <tr key={d.id} className={clsx(highlight === d.id ? 'bg-accent-soft/50' : 'hover:bg-sunken/50')}>
                  <td><Link href={`/services/${d.service.id}`} className="font-medium hover:underline">{d.service.name}</Link></td>
                  <td className="whitespace-nowrap"><Mono className="font-semibold">{d.version}</Mono>{d.isRollback && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[12px] text-serious-ink"><Undo2 className="size-3" aria-hidden />rollback</span>}</td>
                  <td><DeploymentStatusBadge status={d.status} /></td>
                  <td className="text-ink-2">{d.environment}</td>
                  <td>{d.commitSha ? <Mono className="text-ink-2">{d.commitSha.slice(0, 7)}</Mono> : <span className="text-ink-3">—</span>}</td>
                  <td className="max-w-[20rem] truncate text-ink-2">{d.description ?? '—'}</td>
                  <td className="whitespace-nowrap text-ink-2">{d.deployedBy ?? '—'}</td>
                  <td className="whitespace-nowrap text-ink-2" title={dateTime(d.startedAt)}>{timeAgo(d.startedAt)}</td>
                </tr>
              ))}
            </Table>
            <div className="border-t border-line"><Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} /></div>
          </>
        )}
      </Card>
      {adding && <RecordForm onClose={() => setAdding(false)} services={facets.data?.services ?? []} />}
    </>
  );
}

export default function Page() {
  return <Suspense><DeploymentsPage /></Suspense>;
}
