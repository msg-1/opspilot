'use client';

import { Activity, BellRing, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, HealthBadge, SeverityBadge, TierBadge } from '@/components/badges';
import { CHART, Lines, Sparkline } from '@/components/charts';
import { Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, Mono, PageHeader, Select, Spinner, Stat, Table, Tabs } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { compact, dateTime, timeAgo } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { ServiceRef } from '@/lib/types';

interface Overview {
  metrics: Record<string, { label: string; unit: string }>;
  summary: Record<string, number>;
  services: { id: string; name: string; slug: string; tier: string; health: string; healthNote: string | null; ownerTeam: { name: string } | null; latest: Record<string, { value: number; timestamp: string }>; errorRateSparkline: { timestamp: string; value: number }[]; firingAlerts: number }[];
  firingAlerts: { id: string; message: string; value: number; startedAt: string; service: ServiceRef; rule: { name: string; severity: string }; incident: { id: string; number: number } | null }[];
}
interface Rule { id: string; name: string; metric: string; comparator: string; threshold: number; windowMinutes: number; severity: string; enabled: boolean; autoIncident: boolean; firing: boolean; service: ServiceRef }
interface Series { series: { metric: string; label: string; unit: string; points: { timestamp: string; avg: number; max: number }[] }[] }

function RuleForm({ onClose, services, metrics }: { onClose: () => void; services: ServiceRef[]; metrics: Overview['metrics'] }) {
  const { run, busy, error } = useAction();
  const [f, setF] = useState({ service: services[0]?.id ?? '', name: '', metric: 'error_rate', comparator: 'gt', threshold: '5', windowMinutes: '5', severity: 'SEV3', autoIncident: false });
  return (
    <Modal open onClose={onClose} title="New alert rule" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="rule" loading={!!busy}>Create rule</Button></>}>
      <form id="rule" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/monitoring/alert-rules', { ...f, threshold: Number(f.threshold), windowMinutes: Number(f.windowMinutes) }))) onClose(); }}>
        <FormError error={error} />
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Checkout error rate high" />}</Field>
        <Field label="Service">{(id) => <Select id={id} required value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Metric">{(id) => <Select id={id} value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>{Object.entries(metrics).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</Select>}</Field>
          <Field label="Condition">{(id) => <Select id={id} value={f.comparator} onChange={(e) => setF({ ...f, comparator: e.target.value })}><option value="gt">is above</option><option value="lt">is below</option></Select>}</Field>
          <Field label={`Threshold ${metrics[f.metric]?.unit ?? ''}`}>{(id) => <Input id={id} type="number" step="any" required value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Averaged over (minutes)">{(id) => <Input id={id} type="number" min={1} max={1440} required value={f.windowMinutes} onChange={(e) => setF({ ...f, windowMinutes: e.target.value })} />}</Field>
          <Field label="Severity">{(id) => <Select id={id} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['SEV1', 'SEV2', 'SEV3', 'SEV4'].map((s) => <option key={s}>{s}</option>)}</Select>}</Field>
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={f.autoIncident} onChange={(e) => setF({ ...f, autoIncident: e.target.checked })} /><span>Open an incident automatically when this fires<span className="block text-[12px] text-ink-2">Otherwise engineers are notified and decide.</span></span></label>
      </form>
    </Modal>
  );
}

export default function MonitoringPage() {
  const session = useSession();
  const canWrite = session.can('monitoring:write');
  const [tab, setTab] = useState<'health' | 'alerts' | 'rules'>('health');
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState('6h');
  const [adding, setAdding] = useState(false);
  const { run, busy } = useAction();
  const overview = useApi<Overview>('/monitoring/overview', { refetchInterval: 30_000 });
  const rules = useApi<{ data: Rule[] }>(tab === 'rules' ? '/monitoring/alert-rules' : null);
  const current = overview.data?.services.find((s) => s.id === selected) ?? overview.data?.services.find((s) => s.health !== 'HEALTHY' && s.health !== 'UNKNOWN') ?? overview.data?.services[0];
  const series = useApi<Series>(current ? `/monitoring/series?service=${current.id}&metric=error_rate,latency_p95_ms,requests_per_min,cpu_percent,memory_percent,db_connections&from=${range}` : null, { refetchInterval: 60_000, placeholderData: (p) => p });
  const currentRules = useApi<{ data: Rule[] }>(current ? '/monitoring/alert-rules' : null, { staleTime: 60_000 });

  if (overview.error) return <ErrorState error={overview.error} retry={() => void overview.refetch()} />;
  if (overview.isLoading || !overview.data) return <Spinner label="Loading monitoring" />;
  const d = overview.data;
  const latest = (s: Overview['services'][number], m: string) => (s.latest[m] ? `${compact(s.latest[m].value)}${d.metrics[m]?.unit === '%' ? '%' : ''}` : '—');

  return (
    <>
      <PageHeader title="Monitoring" description="Service health computed from the metrics you send and the alert rules you define. Rules are evaluated every minute." actions={canWrite && <Button loading={busy === 'eval'} onClick={() => void run(() => api.post('/monitoring/evaluate'), 'eval')}>Evaluate rules now</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Down" value={d.summary.DOWN ?? 0} tone={d.summary.DOWN ? 'critical' : undefined} />
        <Stat label="Degraded" value={d.summary.DEGRADED ?? 0} tone={d.summary.DEGRADED ? 'warn' : undefined} />
        <Stat label="Healthy" value={d.summary.HEALTHY ?? 0} tone={d.summary.HEALTHY ? 'good' : undefined} />
        <Stat label="No recent data" value={d.summary.UNKNOWN ?? 0} hint="No metrics in the last 15 minutes" />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'health', label: 'Service health' }, { id: 'alerts', label: 'Firing alerts', count: d.firingAlerts.length }, { id: 'rules', label: 'Alert rules' }]} />

      {tab === 'health' && (d.services.length === 0 ? <Card><EmptyState icon={<Activity className="size-5" aria-hidden />} title="No services to monitor" description="Add services to the catalogue first." /></Card> : (
        <div className="space-y-4">
          <Card padded={false}>
            <Table head={<><th>Service</th><th>Health</th><th className="text-right">Error rate</th><th>Trend, 1h</th><th className="text-right">p95 latency</th><th className="text-right">Throughput</th><th className="text-right">CPU</th><th className="text-right">Alerts</th></>}>
              {d.services.map((s) => (
                <tr key={s.id} onClick={() => setSelected(s.id)} className={`cursor-pointer hover:bg-sunken/50 ${current?.id === s.id ? 'bg-accent-soft/40' : ''}`}>
                  <td><button type="button" onClick={() => setSelected(s.id)} aria-pressed={current?.id === s.id} className="text-left font-medium hover:underline">{s.name}</button><div className="flex items-center gap-1.5 text-[12px] text-ink-2"><TierBadge tier={s.tier} />{s.ownerTeam?.name}</div></td>
                  <td><HealthBadge health={s.health} /><div className="mt-0.5 max-w-52 truncate text-[12px] text-ink-2">{s.healthNote}</div></td>
                  <td className="tabular text-right font-medium">{latest(s, 'error_rate')}</td>
                  <td><Sparkline data={s.errorRateSparkline} color={s.health === 'HEALTHY' || s.health === 'UNKNOWN' ? CHART.series : CHART.critical} label={`Error rate trend for ${s.name}`} /></td>
                  <td className="tabular text-right">{s.latest.latency_p95_ms ? `${compact(s.latest.latency_p95_ms.value)} ms` : '—'}</td>
                  <td className="tabular text-right">{s.latest.requests_per_min ? `${compact(s.latest.requests_per_min.value)}/min` : '—'}</td>
                  <td className="tabular text-right">{latest(s, 'cpu_percent')}</td>
                  <td className="tabular text-right">{s.firingAlerts ? <span className="font-semibold text-critical-ink">{s.firingAlerts}</span> : <span className="text-ink-3">0</span>}</td>
                </tr>
              ))}
            </Table>
          </Card>
          {current && (
            <Card title={<span>{current.name} <Link href={`/services/${current.id}`} className="ml-2 text-[13px] font-normal text-accent hover:underline">Open service</Link></span>} actions={<Select aria-label="Time range" className="h-8 w-32" value={range} onChange={(e) => setRange(e.target.value)}><option value="1h">Last hour</option><option value="6h">Last 6 hours</option><option value="24h">Last 24 hours</option><option value="2d">Last 2 days</option></Select>}>
              {series.isLoading ? <Spinner /> : !series.data?.series.some((m) => m.points.length) ? <EmptyState title="No metrics in this range" description="This service has not reported metrics for the selected period." /> : (
                <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
                  {series.data.series.filter((m) => m.points.length).map((m) => {
                    const rule = currentRules.data?.data.find((r) => r.service.id === current.id && r.metric === m.metric && r.enabled);
                    return (
                      <div key={m.metric}>
                        <div className="mb-1 flex items-baseline justify-between"><span className="text-[13px] font-medium">{m.label}</span><span className="tabular text-[13px] text-ink-2">{compact(m.points.at(-1)?.avg)} {m.unit}</span></div>
                        <Lines data={m.points} xKey="timestamp" series={[{ key: 'avg', label: m.label, color: CHART.series }]} unit={m.unit} height={150} withDate={range === '2d'} caption={`${m.label} for ${current.name}`} threshold={rule?.threshold} />
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}
        </div>
      ))}

      {tab === 'alerts' && (
        <Card padded={false}>
          {d.firingAlerts.length === 0 ? <EmptyState icon={<BellRing className="size-5" aria-hidden />} title="No alerts are firing" description="Alerts fire when a rule's metric crosses its threshold, and resolve on their own when it recovers." /> : (
            <Table head={<><th>Alert</th><th>Service</th><th>Severity</th><th>Firing since</th><th>Incident</th></>}>
              {d.firingAlerts.map((a) => (
                <tr key={a.id}>
                  <td className="max-w-[30rem]"><div className="font-medium">{a.rule.name}</div><div className="text-[12px] text-ink-2">{a.message}</div></td>
                  <td><Link href={`/services/${a.service.id}`} className="hover:underline">{a.service.name}</Link></td>
                  <td><SeverityBadge severity={a.rule.severity} short /></td>
                  <td className="whitespace-nowrap text-ink-2" title={dateTime(a.startedAt)}>{timeAgo(a.startedAt)}</td>
                  <td>{a.incident ? <Link href={`/incidents/${a.incident.id}`} className="font-mono text-[12.5px] text-accent hover:underline">INC-{a.incident.number}</Link> : <span className="text-ink-3">None</span>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'rules' && (
        <Card padded={false} title="Alert rules" actions={canWrite && d.services.length > 0 && <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setAdding(true)}>New rule</Button>}>
          {rules.isLoading ? <Spinner /> : !rules.data?.data.length ? <EmptyState title="No alert rules" description="A rule watches one metric of one service, for example error rate above 5% averaged over 5 minutes." /> : (
            <Table head={<><th>Rule</th><th>Service</th><th>Condition</th><th>Severity</th><th>State</th><th /></>}>
              {rules.data.data.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.name}{r.autoIncident && <div className="text-[12px] font-normal text-ink-2">Opens an incident automatically</div>}</td>
                  <td>{r.service.name}</td>
                  <td><Mono>{r.metric} {r.comparator === 'lt' ? '<' : '>'} {r.threshold}</Mono><span className="text-[12px] text-ink-2"> over {r.windowMinutes}m</span></td>
                  <td><SeverityBadge severity={r.severity} short /></td>
                  <td>{!r.enabled ? <Badge>Disabled</Badge> : r.firing ? <Badge tone="critical">Firing</Badge> : <Badge tone="good">OK</Badge>}</td>
                  <td className="text-right whitespace-nowrap">
                    {canWrite && (<>
                      <Button size="sm" variant="ghost" onClick={() => void run(() => api.patch(`/monitoring/alert-rules/${r.id}`, { enabled: !r.enabled }), r.id)}>{r.enabled ? 'Disable' : 'Enable'}</Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete rule ${r.name}`} onClick={() => { if (window.confirm(`Delete the rule "${r.name}"? Its alert history is removed too.`)) void run(() => api.delete(`/monitoring/alert-rules/${r.id}`), r.id); }}><Trash2 className="size-3.5" aria-hidden /></Button>
                    </>)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {adding && <RuleForm onClose={() => setAdding(false)} services={d.services} metrics={d.metrics} />}
    </>
  );
}
