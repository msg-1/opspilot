'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { CHART, SEVERITY_SERIES, StackedBars } from '@/components/charts';
import { Card, EmptyState, ErrorState, PageHeader, Select, Spinner, Stat, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { duration, titleCase } from '@/lib/format';

interface S { count: number; mean: number | null; median: number | null; p90: number | null }
interface Overview {
  incidents: { total: number; open: number; bySeverity: Record<string, number>; weekly: Record<string, number | string>[]; topServices: { id: string; name: string; incidents: number; minutes: number }[]; mttaMinutes: S; mttrMinutes: S; mttrBySeverity: Record<string, S> };
  deployments: { total: number; perDay: number; rollbacks: number; changeFailureRate: number | null; failedChanges: number; daily: { date: string; total: number }[]; byService: { name: string; total: number }[] };
  investigations: { total: number; byStatus: Record<string, number>; averageConfidence: number | null; durationSeconds: S; byProvider: Record<string, number> };
  remediation: { total: number; byStatus: Record<string, number>; proposedByAi: number; approvalMinutes: S };
}

const RANGES: [string, string][] = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['180d', 'Last 6 months']];

/** Horizontal magnitude bars: one hue, value labelled in ink at the end of each bar. */
function RankBars({ items, unit }: { items: { name: string; value: number; hint?: string }[]; unit: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.name}>
          <div className="flex items-baseline justify-between text-[13px]"><span className="truncate">{i.name}</span><span className="tabular ml-3 shrink-0 font-medium">{i.value} <span className="font-normal text-ink-2">{unit}{i.hint ? ` · ${i.hint}` : ''}</span></span></div>
          <div className="mt-1 h-2 rounded-r bg-sunken"><div className="h-full rounded-r" style={{ width: `${(i.value / max) * 100}%`, background: CHART.series }} /></div>
        </li>
      ))}
    </ul>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState('30d');
  const { data, error, isLoading } = useApi<Overview>(`/analytics/overview?from=${range}`, { placeholderData: (p) => p });
  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Spinner label="Computing analytics" />;
  const { incidents: inc, deployments: dep, investigations: inv, remediation: rem } = data;
  const label = RANGES.find(([v]) => v === range)?.[1].toLowerCase();

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Reliability and delivery measures computed from recorded incidents, deployments, investigations and approvals."
        actions={<><Select aria-label="Period" className="w-44" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select><a href={`/api/v1/analytics/incidents.csv?from=${range}`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-sunken"><Download className="size-4" aria-hidden />Export incidents (CSV)</a></>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Incidents" value={inc.total} hint={`${inc.open} still open · ${inc.bySeverity.SEV1 ?? 0} SEV1, ${inc.bySeverity.SEV2 ?? 0} SEV2`} />
        <Stat label="Median time to acknowledge" value={duration(inc.mttaMinutes.median)} hint={inc.mttaMinutes.count ? `90th percentile ${duration(inc.mttaMinutes.p90)} · ${inc.mttaMinutes.count} incidents` : 'No acknowledged incidents'} />
        <Stat label="Median time to resolve" value={duration(inc.mttrMinutes.median)} hint={inc.mttrMinutes.count ? `90th percentile ${duration(inc.mttrMinutes.p90)} · ${inc.mttrMinutes.count} resolved` : 'No resolved incidents'} />
        <Stat label="Change failure rate" value={dep.changeFailureRate === null ? '—' : `${dep.changeFailureRate}%`} hint={`${dep.failedChanges} of ${dep.total - dep.rollbacks} deployments failed, were rolled back, or were followed by an incident within 6 hours`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Incidents per week by severity" description={`Week starting Monday, ${label}`}>
          <StackedBars data={inc.weekly} xKey="week" series={SEVERITY_SERIES} caption="Incidents opened per week, stacked by severity" emptyMessage="No incidents in this period" height={220} />
        </Card>
        <Card title="Deployments per day" description={`${dep.total} deployments, ${dep.perDay} per day on average`}>
          <StackedBars data={dep.daily} xKey="date" series={[{ key: 'total', label: 'Deployments', color: CHART.series }]} caption="Deployments per day" emptyMessage="No deployments in this period" height={220} />
        </Card>
        <Card title="Services with the most incidents">
          {inc.topServices.length ? <RankBars unit="incidents" items={inc.topServices.map((s) => ({ name: s.name, value: s.incidents, hint: `${duration(s.minutes)} in incident` }))} /> : <EmptyState title="No incidents linked to services" />}
        </Card>
        <Card title="Time to resolve by severity" padded={false}>
          <Table head={<><th>Severity</th><th className="text-right">Resolved</th><th className="text-right">Median</th><th className="text-right">Mean</th><th className="text-right">90th percentile</th></>}>
            {['SEV1', 'SEV2', 'SEV3', 'SEV4'].map((s) => { const m = inc.mttrBySeverity[s]; return <tr key={s}><td className="font-medium">{s}</td><td className="tabular text-right">{m?.count ?? 0}</td><td className="tabular text-right">{duration(m?.median)}</td><td className="tabular text-right">{duration(m?.mean)}</td><td className="tabular text-right">{duration(m?.p90)}</td></tr>; })}
          </Table>
        </Card>
        <Card title="AI investigations" description={`${inv.total} run in this period`}>
          {inv.total === 0 ? <EmptyState title="No investigations in this period" /> : (
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-[12px] text-ink-2">Outcomes</dt><dd className="mt-1">{Object.entries(inv.byStatus).map(([k, v]) => `${v} ${titleCase(k).toLowerCase()}`).join(', ')}</dd></div>
              <div><dt className="text-[12px] text-ink-2">Average confidence of completed runs</dt><dd className="tabular mt-1 text-lg font-semibold">{inv.averageConfidence === null ? '—' : `${inv.averageConfidence}%`}</dd></div>
              <div><dt className="text-[12px] text-ink-2">Median duration</dt><dd className="tabular mt-1 text-lg font-semibold">{inv.durationSeconds.median === null ? '—' : `${inv.durationSeconds.median}s`}</dd></div>
              <div><dt className="text-[12px] text-ink-2">Analysis engine</dt><dd className="mt-1">{Object.entries(inv.byProvider).map(([k, v]) => `${k === 'heuristic' ? 'rule-based' : k} (${v})`).join(', ') || '—'}</dd></div>
            </dl>
          )}
        </Card>
        <Card title="Remediation and approvals" description={`${rem.total} actions proposed, ${rem.proposedByAi} by AI`}>
          {rem.total === 0 ? <EmptyState title="No remediation actions in this period" /> : (
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-[12px] text-ink-2">By status</dt><dd className="mt-1">{Object.entries(rem.byStatus).map(([k, v]) => `${v} ${titleCase(k).toLowerCase()}`).join(', ')}</dd></div>
              <div><dt className="text-[12px] text-ink-2">Median time from request to decision</dt><dd className="tabular mt-1 text-lg font-semibold">{duration(rem.approvalMinutes.median)}</dd></div>
            </dl>
          )}
        </Card>
        <Card title="Deployments by service" className="xl:col-span-2">
          {dep.byService.length ? <RankBars unit="deployments" items={dep.byService.map((s) => ({ name: s.name, value: s.total }))} /> : <EmptyState title="No deployments in this period" />}
        </Card>
      </div>
    </>
  );
}
