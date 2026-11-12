'use client';

import clsx from 'clsx';
import { ChevronRight, ScrollText, Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, LevelTag } from '@/components/badges';
import { CHART, StackedBars } from '@/components/charts';
import { Button, Card, EmptyState, ErrorState, Input, Mono, PageHeader, Pagination, Select, Spinner, Tabs } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { clock, compact, dateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { LogEntry, Paged, ServiceRef } from '@/lib/types';

interface Pattern { fingerprint: string; sample: string; level: string; serviceName: string | null; serviceSlug: string | null; count: number; firstSeen: string; lastSeen: string; kind?: string; ratio?: number | null; baselineCount?: number }

const RANGES: [string, string][] = [['15m', 'Last 15 minutes'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours'], ['3d', 'Last 3 days'], ['7d', 'Last 7 days']];
const LEVELS = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG'];
const LEVEL_SERIES = [
  { key: 'FATAL', label: 'Fatal', color: '#a32222' },
  { key: 'ERROR', label: 'Error', color: CHART.critical },
  { key: 'WARN', label: 'Warn', color: CHART.warning },
  { key: 'INFO', label: 'Info', color: CHART.series },
  { key: 'DEBUG', label: 'Debug', color: CHART.neutral },
];

function LogRow({ log, onFilter }: { log: LogEntry; onFilter: (patch: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-sunken/60">
        <ChevronRight className={clsx('mt-1 size-3 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} aria-hidden />
        <time className="tabular shrink-0 font-mono text-[12px] text-ink-2" dateTime={log.timestamp} title={new Date(log.timestamp).toLocaleString()}>{clock(log.timestamp)}</time>
        <LevelTag level={log.level} />
        <span className="hidden w-36 shrink-0 truncate font-mono text-[12px] text-ink-2 sm:block">{log.service?.slug ?? '—'}</span>
        <span className={clsx('min-w-0 flex-1 font-mono text-[12.5px] text-ink', open ? 'break-all whitespace-pre-wrap' : 'truncate')}>{log.message}</span>
      </button>
      {open && (
        <div className="space-y-2 bg-sunken/50 px-9 py-3 text-[12px]">
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-2">Time</dt><dd className="font-mono">{new Date(log.timestamp).toISOString()}</dd>
            <dt className="text-ink-2">Service</dt><dd>{log.service?.name ?? 'Not linked to a service'}</dd>
            <dt className="text-ink-2">Environment</dt><dd>{log.environment}{log.host ? ` · ${log.host}` : ''}</dd>
            {log.traceId && (<><dt className="text-ink-2">Trace</dt><dd><Mono>{log.traceId}</Mono></dd></>)}
            <dt className="text-ink-2">Pattern</dt><dd><Mono>{log.fingerprint}</Mono></dd>
          </dl>
          {log.attributes && <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2 font-mono text-[11.5px]">{JSON.stringify(log.attributes, null, 2)}</pre>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onFilter({ fingerprint: log.fingerprint })}>Show all like this</Button>
            {log.traceId && <Button size="sm" onClick={() => onFilter({ traceId: log.traceId as string })}>Follow this trace</Button>}
          </div>
        </div>
      )}
    </li>
  );
}

function PatternList({ items, anomalies, onPick }: { items: Pattern[]; anomalies?: boolean; onPick: (fp: string) => void }) {
  if (!items.length) return <EmptyState title={anomalies ? 'Nothing unusual in this window' : 'No patterns'} description={anomalies ? 'No error or warning pattern is new or at least three times more frequent than in the preceding baseline period (six times the selected window).' : 'No logs match these filters.'} />;
  const max = Math.max(...items.map((p) => p.count));
  return (
    <ul>
      {items.map((p) => (
        <li key={p.fingerprint + p.serviceSlug} className="border-b border-line last:border-0">
          <button type="button" onClick={() => onPick(p.fingerprint)} className="block w-full px-4 py-2.5 text-left hover:bg-sunken/60">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
              <LevelTag level={p.level} />
              <span className="tabular text-sm font-semibold text-ink">{compact(p.count)}×</span>
              <span>{p.serviceName ?? 'no service'}</span>
              {p.kind === 'new' && <Badge tone="critical">New pattern</Badge>}
              {p.kind === 'spike' && <Badge tone="serious">{p.ratio}× the baseline rate</Badge>}
              <span className="ml-auto">first {dateTime(p.firstSeen)} · last {dateTime(p.lastSeen)}</span>
            </div>
            <Mono className="mt-1 block truncate text-ink">{p.sample}</Mono>
            <div className="mt-1.5 h-1 rounded-full bg-sunken"><div className="h-full rounded-full bg-ink-3" style={{ width: `${Math.max(2, (p.count / max) * 100)}%` }} /></div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LogsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const [text, setText] = useState(get('q'));
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'stream' | 'patterns' | 'anomalies'>('stream');
  const q = useDebounced(text, 350);

  // Filters live in the URL so a log view can be shared or linked from an investigation.
  const filters = { service: get('service'), level: get('level'), from: get('from') || '1h', traceId: get('traceId'), fingerprint: get('fingerprint'), environment: get('environment') };
  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v); else next.delete(k);
    setPage(1);
    router.replace(`/logs?${next.toString()}`);
  };
  const query = qs({ ...filters, q });
  const facets = useApi<{ services: ServiceRef[]; environments: string[] }>('/logs/facets', { staleTime: 60_000 });
  const histogram = useApi<{ buckets: Record<string, number | string>[] }>(`/logs/histogram${query}`, { placeholderData: (p) => p });
  const logs = useApi<Paged<LogEntry>>(tab === 'stream' ? `/logs${query}&page=${page}&pageSize=100` : null, { placeholderData: (p) => p });
  const patterns = useApi<{ data: Pattern[] }>(tab === 'patterns' ? `/logs/patterns${query}` : null);
  const anomalies = useApi<{ data: Pattern[] }>(tab === 'anomalies' ? `/logs/anomalies${query}` : null);
  const levels = filters.level ? filters.level.split(',') : [];
  const toggleLevel = (l: string) => update({ level: (levels.includes(l) ? levels.filter((x) => x !== l) : [...levels, l]).join(',') });
  const chips = [filters.fingerprint && ['fingerprint', `Pattern ${filters.fingerprint}`], filters.traceId && ['traceId', `Trace ${filters.traceId.slice(0, 12)}…`]].filter(Boolean) as [string, string][];
  const error = logs.error ?? histogram.error;

  return (
    <>
      <PageHeader title="Log explorer" description="Search structured logs across services, group them into patterns, and see which errors are new or spiking against their baseline." />
      <Card className="mb-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" aria-hidden />
            <Input aria-label="Search log messages" placeholder="Search message text, e.g. timeout acquiring connection" className="pl-8 font-mono text-[13px]" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} />
          </div>
          <Select aria-label="Service" className="w-48" value={filters.service} onChange={(e) => update({ service: e.target.value })}>
            <option value="">All services</option>
            {facets.data?.services.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
          </Select>
          <Select aria-label="Time range" className="w-44" value={filters.from} onChange={(e) => update({ from: e.target.value })}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-ink-2">Level</span>
          {LEVELS.map((l) => <button key={l} type="button" aria-pressed={levels.includes(l)} onClick={() => toggleLevel(l)} className={clsx('rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold', levels.includes(l) ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:border-line-strong')}>{l}</button>)}
          {chips.map(([k, label]) => <button key={k} type="button" onClick={() => update({ [k]: '' })} className="ml-1 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent-strong">{label}<X className="size-3" aria-label="Remove filter" /></button>)}
        </div>
        <div className="mt-4">
          <StackedBars data={histogram.data?.buckets ?? []} xKey="timestamp" series={LEVEL_SERIES.filter((s) => histogram.data?.buckets.some((b) => Number(b[s.key]) > 0))} time withDate={['3d', '7d'].includes(filters.from)} height={120} caption="Log volume over time by level" emptyMessage={histogram.isLoading ? 'Loading…' : 'No logs in this time range'} />
        </div>
      </Card>

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stream', label: 'Log lines', count: logs.data?.meta.total }, { id: 'patterns', label: 'Patterns' }, { id: 'anomalies', label: 'New and spiking' }]} />
      <Card padded={false}>
        {error ? <div className="p-4"><ErrorState error={error} retry={() => void logs.refetch()} /></div> : tab === 'stream' ? (
          logs.isLoading || !logs.data ? <Spinner /> : logs.data.data.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-5" aria-hidden />} title="No log lines match" description={<>Widen the time range or remove filters. To send logs, POST batches to <Mono>/api/v1/logs</Mono> with an API key that has the <Mono>ingest:logs</Mono> scope.</>} />
          ) : (
            <>
              <ul>{logs.data.data.map((l) => <LogRow key={l.id} log={l} onFilter={update} />)}</ul>
              <div className="border-t border-line"><Pagination page={logs.data.meta.page} totalPages={logs.data.meta.totalPages} total={logs.data.meta.total} onPage={setPage} /></div>
            </>
          )
        ) : tab === 'patterns' ? (
          patterns.isLoading || !patterns.data ? <Spinner /> : <PatternList items={patterns.data.data} onPick={(fp) => { update({ fingerprint: fp }); setTab('stream'); }} />
        ) : anomalies.isLoading || !anomalies.data ? <Spinner label="Comparing with baseline" /> : <PatternList items={anomalies.data.data} anomalies onPick={(fp) => { update({ fingerprint: fp }); setTab('stream'); }} />}
      </Card>
    </>
  );
}

export default function Page() {
  return <Suspense><LogsPage /></Suspense>;
}
