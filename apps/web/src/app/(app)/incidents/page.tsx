'use client';

import { Plus, Search, Siren } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { IncidentStatusBadge, SeverityBadge } from '@/components/badges';
import { Avatar, Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, Mono, PageHeader, Pagination, Select, Spinner, Table, Tabs, Textarea } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { duration, timeAgo } from '@/lib/format';
import { useAction, useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Incident, Paged, Service } from '@/lib/types';

type View = 'active' | 'resolved' | 'all';

function NewIncident({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const services = useApi<Paged<Service>>(open ? '/services?pageSize=200' : null);
  const { run, busy, error } = useAction();
  const [form, setForm] = useState({ title: '', severity: 'SEV3', description: '', customerImpact: '' });
  const [serviceIds, setServiceIds] = useState<string[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const created = await run(() => api.post<Incident>('/incidents', { ...form, description: form.description || null, customerImpact: form.customerImpact || null, serviceIds }));
    if (created) router.push(`/incidents/${created.id}`);
  }

  return (
    <Modal open={open} onClose={onClose} title="Declare an incident" wide footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-incident" loading={!!busy}>Declare incident</Button></>}>
      <form id="new-incident" onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        <Field label="What is happening?" hint="A short, specific title. Symptoms, not causes.">
          {(id) => <Input id={id} required minLength={4} maxLength={200} autoFocus placeholder="Checkout requests failing with 503s" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
        </Field>
        <Field label="Severity">
          {(id) => (
            <Select id={id} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
              <option value="SEV1">SEV1 · Critical path down for most customers</option>
              <option value="SEV2">SEV2 · Critical path degraded or down for some</option>
              <option value="SEV3">SEV3 · Non-critical feature impaired</option>
              <option value="SEV4">SEV4 · Minor or cosmetic</option>
            </Select>
          )}
        </Field>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Affected services</legend>
          {services.isLoading ? <Spinner /> : services.data?.data.length ? (
            <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-line p-2.5">
              {services.data.data.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={serviceIds.includes(s.id)} onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((x) => x !== s.id))} />
                  {s.name}
                </label>
              ))}
            </div>
          ) : <p className="text-[13px] text-ink-2">No services in the catalogue yet. You can link them later.</p>}
        </fieldset>
        <Field label="Details">{(id) => <Textarea id={id} rows={3} maxLength={10000} placeholder="What you know so far, how it was detected" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        <Field label="Customer impact">{(id) => <Input id={id} maxLength={2000} placeholder="Who is affected and how" value={form.customerImpact} onChange={(e) => setForm({ ...form, customerImpact: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

function IncidentsPage() {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<View>('active');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  const creating = params.get('new') === '1';

  const { data, error, isLoading, refetch } = useApi<Paged<Incident> & { statusCounts: Record<string, number> }>(
    `/incidents${qs({ q, severity, page, pageSize: 20, active: view === 'all' ? undefined : view === 'active' ? 'true' : 'false', sort: view === 'active' ? 'severity' : 'startedAt' })}`,
    { refetchInterval: 30_000, placeholderData: (prev) => prev },
  );
  const counts = data?.statusCounts ?? {};
  const active = (counts.OPEN ?? 0) + (counts.INVESTIGATING ?? 0) + (counts.IDENTIFIED ?? 0) + (counts.MITIGATED ?? 0);
  const resolved = (counts.RESOLVED ?? 0) + (counts.CLOSED ?? 0);

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Everything that has gone wrong, who is on it, and how it was resolved."
        actions={session.can('incident:write') && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => router.push('/incidents?new=1')}>Declare incident</Button>}
      />
      <Tabs
        value={view}
        onChange={(v) => { setView(v); setPage(1); }}
        tabs={[{ id: 'active', label: 'Active', count: active }, { id: 'resolved', label: 'Resolved', count: resolved }, { id: 'all', label: 'All', count: active + resolved }]}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search incidents" placeholder="Search by title, description or INC number" className="pl-8" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Select aria-label="Severity" className="w-40" value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
          <option value="">All severities</option>
          {['SEV1', 'SEV2', 'SEV3', 'SEV4'].map((s) => <option key={s}>{s}</option>)}
        </Select>
      </div>
      <Card padded={false}>
        {error ? <div className="p-4"><ErrorState error={error} retry={() => void refetch()} /></div> : isLoading || !data ? <Spinner /> : data.data.length === 0 ? (
          <EmptyState
            icon={<Siren className="size-5" aria-hidden />}
            title={q || severity ? 'No incidents match these filters' : view === 'active' ? 'No active incidents' : 'No incidents yet'}
            description={q || severity ? 'Try a different search or clear the severity filter.' : 'Incidents are declared by a person, or opened automatically by an alert rule with auto-incident enabled.'}
          />
        ) : (
          <>
            <Table head={<><th>Incident</th><th>Severity</th><th>Status</th><th>Services</th><th>Assignee</th><th>Started</th><th className="text-right">Duration</th></>}>
              {data.data.map((i) => (
                <tr key={i.id} className="hover:bg-sunken/50">
                  <td className="max-w-[26rem]">
                    <Link href={`/incidents/${i.id}`} className="block">
                      <Mono className="text-ink-2">{i.key}</Mono>
                      <div className="truncate font-medium text-ink hover:underline">{i.title}</div>
                    </Link>
                  </td>
                  <td><SeverityBadge severity={i.severity} short /></td>
                  <td><IncidentStatusBadge status={i.status} /></td>
                  <td className="max-w-48 truncate text-ink-2">{i.services.map((s) => s.name).join(', ') || '—'}</td>
                  <td>{i.assignee ? <span className="flex items-center gap-1.5 whitespace-nowrap"><Avatar name={i.assignee.name} size={20} />{i.assignee.name}</span> : <span className="text-ink-3">Unassigned</span>}</td>
                  <td className="whitespace-nowrap text-ink-2">{timeAgo(i.startedAt)}</td>
                  <td className="tabular text-right whitespace-nowrap text-ink-2">{duration(i.durationMinutes)}</td>
                </tr>
              ))}
            </Table>
            <div className="border-t border-line"><Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} /></div>
          </>
        )}
      </Card>
      <NewIncident open={creating} onClose={() => router.replace('/incidents')} />
    </>
  );
}

export default function Page() {
  return <Suspense><IncidentsPage /></Suspense>;
}
