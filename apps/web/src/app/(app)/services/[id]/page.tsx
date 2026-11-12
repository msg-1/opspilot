'use client';

import { ArrowRight, ExternalLink, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { DeploymentStatusBadge, HealthBadge, HealthDot, IncidentStatusBadge, SampleDataBadge, SeverityBadge, TierBadge } from '@/components/badges';
import { CHART, Lines } from '@/components/charts';
import { ServiceForm } from '@/components/service-form';
import { Button, Card, DefinitionList, EmptyState, ErrorState, FormError, LinkButton, Modal, Mono, Notice, PageHeader, Select, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { dateTime, timeAgo, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Deployment, Paged, Service, ServiceRef } from '@/lib/types';

interface Dep extends ServiceRef { health: string; tier: string; kind: string }
interface Detail extends Service {
  dependencies: Dep[];
  dependents: Dep[];
  onCall: { id: string; name: string }[];
  repositories: { id: string; fullName: string; url: string | null; isMock: boolean }[];
  recentDeployments: Deployment[];
  recentIncidents: { id: string; number: number; title: string; severity: string; status: string; startedAt: string }[];
  recentEvents: { id: string; type: string; title: string; occurredAt: string; actor: string | null }[];
  firingAlerts: { id: string; message: string; startedAt: string }[];
  errorsLast24h: number;
}
interface Series { series: { metric: string; label: string; unit: string; points: { timestamp: string; avg: number }[] }[] }

function DependencyEditor({ service, onClose }: { service: Detail; onClose: () => void }) {
  const all = useApi<Paged<Service>>('/services?pageSize=200');
  const { run, busy, error } = useAction();
  const [deps, setDeps] = useState<Record<string, string>>(Object.fromEntries(service.dependencies.map((d) => [d.id, d.kind])));
  return (
    <Modal open onClose={onClose} title={`What does ${service.name} depend on?`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={!!busy} onClick={async () => { if (await run(() => api.put(`/services/${service.id}/dependencies`, { dependencies: Object.entries(deps).map(([serviceId, kind]) => ({ serviceId, kind })) }))) onClose(); }}>Save dependencies</Button></>}>
      <FormError error={error} />
      <p className="mb-3 text-[13px] text-ink-2">Investigations follow these links to look for upstream causes.</p>
      {all.isLoading ? <Spinner /> : (
        <ul className="space-y-1.5">
          {all.data?.data.filter((s) => s.id !== service.id).map((s) => (
            <li key={s.id} className="flex items-center gap-3">
              <label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" checked={s.id in deps} onChange={(e) => setDeps((d) => { const next = { ...d }; if (e.target.checked) next[s.id] = 'sync'; else delete next[s.id]; return next; })} />{s.name}</label>
              {s.id in deps && <Select aria-label={`How ${service.name} uses ${s.name}`} className="h-8 w-36" value={deps[s.id]} onChange={(e) => setDeps((d) => ({ ...d, [s.id]: e.target.value }))}><option value="sync">Synchronous call</option><option value="async">Async / queue</option><option value="datastore">Data store</option></Select>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function DepList({ title, items, empty }: { title: string; items: Dep[]; empty: string }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">{title}</h3>
      {items.length === 0 ? <p className="text-[13px] text-ink-3">{empty}</p> : (
        <ul className="space-y-1">
          {items.map((d) => (
            <li key={d.id}><Link href={`/services/${d.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sunken"><HealthDot health={d.health} /><span className="flex-1 font-medium">{d.name}</span><span className="text-[12px] text-ink-3">{d.kind}</span><ArrowRight className="size-3.5 text-ink-3" aria-hidden /></Link></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ServicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const canWrite = session.can('service:write');
  const { data: s, error, isLoading } = useApi<Detail>(`/services/${id}`, { refetchInterval: 30_000 });
  const metrics = useApi<Series>(s ? `/monitoring/series?service=${s.id}&metric=error_rate,latency_p95_ms,requests_per_min&from=6h` : null, { refetchInterval: 60_000 });
  const [editing, setEditing] = useState(false);
  const [editingDeps, setEditingDeps] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { run, busy, error: actionError } = useAction();

  if (error) return <ErrorState error={error} />;
  if (isLoading || !s) return <Spinner label="Loading service" />;
  const deployMarkers = s.recentDeployments.filter((d) => Date.now() - new Date(d.startedAt).getTime() < 6 * 3600_000).map((d) => ({ at: d.startedAt, label: d.version }));

  return (
    <>
      <PageHeader
        back={{ href: '/services', label: 'Services' }}
        title={s.name}
        description={<span className="mt-1 flex flex-wrap items-center gap-2"><HealthBadge health={s.health} /><TierBadge tier={s.tier} />{s.healthNote && <span>{s.healthNote}</span>}</span>}
        actions={canWrite && <><Button icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(true)}>Edit</Button><Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button></>}
      />
      {s.description && <p className="mb-4 max-w-3xl text-sm text-ink-2">{s.description}</p>}
      {s.firingAlerts.map((a) => <div key={a.id} className="mb-3"><Notice tone="warn"><strong>Alert firing since {dateTime(a.startedAt)}:</strong> {a.message}</Notice></div>)}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card title="Last 6 hours" actions={<LinkButton href={`/logs?service=${s.slug}&level=ERROR,FATAL&from=24h`} size="sm" variant="ghost">{s.errorsLast24h.toLocaleString()} errors in 24h</LinkButton>}>
            {metrics.isLoading ? <Spinner /> : !metrics.data?.series.some((m) => m.points.length) ? (
              <EmptyState title="No metrics received" description={<>Send samples to <Mono>POST /api/v1/monitoring/metrics</Mono> with an API key that has the <Mono>ingest:metrics</Mono> scope.</>} />
            ) : (
              <div className="grid gap-5 md:grid-cols-3">
                {metrics.data.series.map((m) => (
                  <div key={m.metric}>
                    <div className="mb-1 flex items-baseline justify-between"><span className="text-[13px] font-medium">{m.label}</span><span className="tabular text-[13px] text-ink-2">{m.points.at(-1)?.avg ?? '—'} {m.unit}</span></div>
                    {/* Each metric gets its own chart and axis; scales differ too much to share one. */}
                    <Lines data={m.points} xKey="timestamp" series={[{ key: 'avg', label: m.label, color: CHART.series }]} unit={m.unit} height={130} caption={`${m.label} for ${s.name} over the last 6 hours`} markers={deployMarkers} />
                  </div>
                ))}
              </div>
            )}
            {deployMarkers.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Dashed vertical lines mark deployments.</p>}
          </Card>

          <Card title="Recent deployments" padded={false} actions={<LinkButton href={`/deployments?service=${s.slug}`} size="sm" variant="ghost">All</LinkButton>}>
            {s.recentDeployments.length === 0 ? <EmptyState title="No deployments recorded for this service" /> : (
              <ul>
                {s.recentDeployments.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 last:border-0">
                    <Mono className="font-semibold">{d.version}</Mono><DeploymentStatusBadge status={d.status} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{d.description ?? ''}</span>
                    <span className="text-[12px] text-ink-2">{d.deployedBy} · {timeAgo(d.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Incident history" padded={false}>
            {s.recentIncidents.length === 0 ? <EmptyState title="No incidents have involved this service" /> : (
              <ul>
                {s.recentIncidents.map((i) => (
                  <li key={i.id} className="border-b border-line last:border-0">
                    <Link href={`/incidents/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-sunken/60">
                      <SeverityBadge severity={i.severity} short /><Mono className="text-ink-2">INC-{i.number}</Mono>
                      <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span><IncidentStatusBadge status={i.status} /><span className="text-[12px] text-ink-2">{timeAgo(i.startedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="About">
            <DefinitionList
              items={[
                ['Identifier', <Mono key="s">{s.slug}</Mono>],
                ['Owner', s.ownerTeam?.name ?? '—'],
                ['On call', s.onCall.length ? s.onCall.map((p) => p.name).join(', ') : '—'],
                ['Language', s.language ?? '—'],
                ['Lifecycle', titleCase(s.lifecycle)],
                ['Repositories', s.repositories.length ? <span className="space-y-1">{s.repositories.map((r) => <span key={r.id} className="flex flex-wrap items-center gap-1.5"><Mono>{r.fullName}</Mono>{r.isMock && <SampleDataBadge />}</span>)}</span> : s.repoUrl ? <a href={s.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Repository<ExternalLink className="size-3" aria-hidden /></a> : '—'],
                ['Tags', s.tags.length ? s.tags.join(', ') : '—'],
              ]}
            />
          </Card>
          <Card title="Dependencies" actions={canWrite && <Button size="sm" onClick={() => setEditingDeps(true)}>Edit</Button>}>
            <div className="space-y-4">
              <DepList title="Depends on" items={s.dependencies} empty="No upstream dependencies recorded." />
              <DepList title="Used by" items={s.dependents} empty="Nothing depends on this service." />
            </div>
          </Card>
          <Card title="Operational events" padded={false}>
            {s.recentEvents.length === 0 ? <p className="px-4 py-4 text-[13px] text-ink-2">No config changes, flag flips, restarts or scaling events recorded.</p> : (
              <ul>{s.recentEvents.map((e) => <li key={e.id} className="border-b border-line px-4 py-2.5 last:border-0"><div className="text-[13px]">{e.title}</div><div className="text-[12px] text-ink-2">{titleCase(e.type)} · {e.actor} · {timeAgo(e.occurredAt)}</div></li>)}</ul>
            )}
          </Card>
        </div>
      </div>

      {editing && <ServiceForm open onClose={() => setEditing(false)} service={s} />}
      {editingDeps && <DependencyEditor service={s} onClose={() => setEditingDeps(false)} />}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${s.name}?`} footer={<><Button onClick={() => setConfirmDelete(false)}>Keep service</Button><Button variant="danger" loading={!!busy} onClick={async () => { await run(() => api.delete(`/services/${s.id}`)); router.replace('/services'); }}>Delete service</Button></>}>
        <FormError error={actionError} />
        <p className="text-sm text-ink-2">This permanently removes the service with its deployments, metrics, alert rules and service events. Logs and incidents are kept but lose their link to it.</p>
      </Modal>
    </>
  );
}
