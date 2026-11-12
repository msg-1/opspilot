'use client';

import clsx from 'clsx';
import { Activity, AlertTriangle, BookOpen, Bot, Boxes, HeartPulse, Route, ChevronDown, CircleHelp, FileCode2, GitPullRequest, ListChecks, Rocket, ScrollText, ShieldAlert, Siren, Sparkles, TrendingUp, Wrench, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ConfidenceMeter, EffectBadge, EngineBadge, InvestigationStatusBadge, RemediationStatusBadge, RiskBadge, SeverityBadge } from '@/components/badges';
import { AssessmentCard, IntegritySummary, VerificationMark } from '@/components/findings';
import { Button, Card, EmptyState, ErrorState, FormError, Mono, Notice, PageHeader, Spinner, Tabs } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { clock, dateTime, timeAgo, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Evidence, Hypothesis, InvestigationSummary, RemediationSummary, Report, Step } from '@/lib/types';

interface Detail extends InvestigationSummary {
  plan: { objective: string; services: string[]; windowFrom: string; windowTo: string; steps: { description: string; tool: string }[] } | null;
  report: Report | null;
  steps: Step[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  remediations: RemediationSummary[];
  createdBy: { id: string; name: string } | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmCalls: number;
  llmLatencyMs: number;
}

const KIND: Record<string, { icon: React.ElementType; label: string }> = {
  log_pattern: { icon: ScrollText, label: 'Log pattern' },
  log: { icon: ScrollText, label: 'Log line' },
  deployment: { icon: Rocket, label: 'Deployment' },
  commit: { icon: FileCode2, label: 'Commit' },
  pull_request: { icon: GitPullRequest, label: 'Pull request' },
  metric: { icon: TrendingUp, label: 'Metric' },
  service_event: { icon: Wrench, label: 'Service event' },
  alert: { icon: AlertTriangle, label: 'Alert' },
  incident: { icon: Siren, label: 'Past incident' },
  document: { icon: BookOpen, label: 'Knowledge base' },
  dependency: { icon: Boxes, label: 'Dependency' },
  metric_baseline: { icon: Activity, label: 'Steady metrics' },
  service_health: { icon: HeartPulse, label: 'Service health' },
  deployment_impact: { icon: TrendingUp, label: 'Deployment impact' },
  trace: { icon: Route, label: 'Trace' },
};

function sourceLink(e: Evidence): string | null {
  const data = e.data ?? {};
  switch (e.sourceType) {
    case 'deployment': return `/deployments?highlight=${e.sourceId}`;
    case 'incident': return `/incidents/${e.sourceId}`;
    case 'knowledge_chunk': return typeof data.documentId === 'string' ? `/knowledge/${data.documentId}` : null;
    case 'log_pattern': return typeof data.fingerprint === 'string' ? `/logs?fingerprint=${data.fingerprint}&from=24h` : null;
    case 'log': return typeof data.fingerprint === 'string' ? `/logs?fingerprint=${data.fingerprint}&from=24h` : null;
    case 'commit':
    case 'pull_request': return '/changes';
    case 'metric':
    case 'alert': return '/monitoring';
    default: return null;
  }
}

/** Inline evidence reference: hover or focus shows what it points to; click jumps to the evidence list. */
function RefChip({ id, evidence, onSelect }: { id: string; evidence: Map<string, Evidence>; onSelect: (ref: string) => void }) {
  const e = evidence.get(id);
  return (
    <button type="button" onClick={() => onSelect(id)} title={e ? `${KIND[e.kind]?.label ?? e.kind}: ${e.title}` : 'Evidence'} className="tabular mx-0.5 rounded border border-accent/30 bg-accent-soft px-1 font-mono text-[11px] font-semibold text-accent-strong hover:bg-accent hover:text-white">
      {id}
    </button>
  );
}

/** Renders text, turning "E12" style references into chips. */
function WithRefs({ text, evidence, onSelect }: { text: string; evidence: Map<string, Evidence>; onSelect: (ref: string) => void }) {
  const parts = text.split(/\b(E\d{1,3})\b/g);
  return <>{parts.map((p, i) => (/^E\d{1,3}$/.test(p) && evidence.has(p) ? <RefChip key={i} id={p} evidence={evidence} onSelect={onSelect} /> : <span key={i}>{p}</span>))}</>;
}

function Refs({ refs, evidence, onSelect }: { refs: string[]; evidence: Map<string, Evidence>; onSelect: (ref: string) => void }) {
  if (!refs.length) return <span className="text-[12px] text-ink-3">no evidence cited</span>;
  return <span className="inline-flex flex-wrap gap-y-1">{refs.map((r) => <RefChip key={r} id={r} evidence={evidence} onSelect={onSelect} />)}</span>;
}

function HypothesisCard({ h, evidence, onSelect, top }: { h: Hypothesis; evidence: Map<string, Evidence>; onSelect: (ref: string) => void; top: boolean }) {
  const [open, setOpen] = useState(top);
  const List = ({ title, items, tone }: { title: string; items: string[]; tone?: string }) =>
    items.length ? (
      <div>
        <div className={clsx('text-[11px] font-semibold tracking-wide uppercase', tone ?? 'text-ink-2')}>{title}</div>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-[13px] text-ink">{items.map((f, i) => <li key={i}><WithRefs text={f} evidence={evidence} onSelect={onSelect} /></li>)}</ul>
      </div>
    ) : null;
  return (
    <div className={clsx('rounded-lg border', top ? 'border-accent/40 bg-accent-soft/30' : 'border-line')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-white">{h.rank}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{h.title}</span>
          <span className="mt-1.5 block"><ConfidenceMeter value={h.confidence} status={h.status} /></span>
        </span>
        <ChevronDown className={clsx('mt-1 size-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line/70 px-4 py-3">
          <p className="text-sm text-ink"><WithRefs text={h.description} evidence={evidence} onSelect={onSelect} /></p>
          <div className="text-[13px] text-ink-2">Supporting evidence: <Refs refs={h.evidenceRefs} evidence={evidence} onSelect={onSelect} /></div>
          {(h.contradictions.length > 0 || h.contradictingRefs.length > 0) && (
            <div>
              <div className="text-[11px] font-semibold tracking-wide text-critical-ink uppercase">Evidence against</div>
              {h.contradictions.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-4 text-[13px] text-ink">{h.contradictions.map((c, i) => <li key={i}><WithRefs text={c} evidence={evidence} onSelect={onSelect} /></li>)}</ul>}
              {h.contradictingRefs.length > 0 && <div className="mt-1 text-[13px] text-ink-2">Contradicting evidence: <Refs refs={h.contradictingRefs} evidence={evidence} onSelect={onSelect} /></div>}
            </div>
          )}
          <List title="Observed facts" items={h.facts} tone="text-good-ink" />
          <List title="Assumptions (not verified)" items={h.assumptions} tone="text-warn-ink" />
          <List title="Missing evidence: what would confirm or refute it" items={h.gaps} />
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const hasBody = step.input != null || step.output != null || (step.detail && step.detail.length > 140);
  const icon = step.type === 'plan' ? <ListChecks className="size-3.5" aria-hidden /> : step.type === 'tool_call' ? <Wrench className="size-3.5" aria-hidden /> : step.type === 'guardrail' ? <ShieldAlert className="size-3.5" aria-hidden /> : step.type === 'error' ? <XCircle className="size-3.5" aria-hidden /> : step.type === 'hypothesis' ? <CircleHelp className="size-3.5" aria-hidden /> : <Bot className="size-3.5" aria-hidden />;
  return (
    <li className="relative pb-3 pl-6 last:pb-0">
      <span className={clsx('absolute top-0.5 -left-[11px] flex size-[22px] items-center justify-center rounded-full border bg-surface', step.status === 'failed' ? 'border-critical/40 text-critical-ink' : step.type === 'guardrail' ? 'border-warn/60 text-warn-ink' : 'border-line text-ink-2')}>{icon}</span>
      <button type="button" disabled={!hasBody} onClick={() => setOpen((o) => !o)} aria-expanded={hasBody ? open : undefined} className="w-full text-left">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-ink">{step.title}</span>
          {step.toolName && <Mono className="text-ink-2">{step.toolName}</Mono>}
          {step.durationMs !== null && <span className="tabular text-[11px] text-ink-3">{step.durationMs} ms</span>}
          <span className="text-[11px] text-ink-3">{clock(step.createdAt)}</span>
          {hasBody && <ChevronDown className={clsx('size-3 text-ink-3 transition-transform', open && 'rotate-180')} aria-hidden />}
        </div>
        {step.detail && <p className={clsx('mt-0.5 text-[13px] whitespace-pre-wrap text-ink-2', !open && 'line-clamp-2')}>{step.detail}</p>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {step.input != null && <pre className="max-h-40 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11.5px] text-ink-2"><span className="text-ink-3">input </span>{JSON.stringify(step.input, null, 2)}</pre>}
          {step.output != null && <pre className="max-h-72 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11.5px] text-ink-2"><span className="text-ink-3">output </span>{JSON.stringify(step.output, null, 2)}</pre>}
        </div>
      )}
    </li>
  );
}

function EvidenceList({ items, selected, cited }: { items: Evidence[]; selected: string | null; cited: Set<string> }) {
  const [kind, setKind] = useState('all');
  const [order, setOrder] = useState<'time' | 'ref'>('time');
  const kinds = [...new Set(items.map((e) => e.kind))];
  const shown = useMemo(() => {
    const list = items.filter((e) => kind === 'all' || e.kind === kind);
    return order === 'ref' ? list : [...list].sort((a, b) => (a.occurredAt ?? '9').localeCompare(b.occurredAt ?? '9'));
  }, [items, kind, order]);
  if (!items.length) return <EmptyState title="No evidence collected" description="The tools returned nothing relevant for this question and time window." />;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {['all', ...kinds].map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} className={clsx('rounded-full border px-2.5 py-0.5 text-[12px]', kind === k ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:border-line-strong')}>
            {k === 'all' ? `All ${items.length}` : `${KIND[k]?.label ?? k} ${items.filter((e) => e.kind === k).length}`}
          </button>
        ))}
        <button type="button" onClick={() => setOrder(order === 'time' ? 'ref' : 'time')} className="ml-auto text-[12px] text-ink-2 underline-offset-2 hover:underline">
          Sorted by {order === 'time' ? 'time of event' : 'order collected'}
        </button>
      </div>
      <ol className="relative ml-3 border-l border-line">
        {shown.map((e) => {
          const K = KIND[e.kind] ?? { icon: CircleHelp, label: e.kind };
          const link = sourceLink(e);
          return (
            <li key={e.id} id={`ev-${e.ref}`} className={clsx('relative scroll-mt-20 pb-3 pl-6 last:pb-0')}>
              <span className="absolute top-0.5 -left-[11px] flex size-[22px] items-center justify-center rounded-full border border-line bg-surface text-ink-2"><K.icon className="size-3.5" aria-hidden /></span>
              <div className={clsx('rounded-lg border px-3 py-2', selected === e.ref ? 'border-accent bg-accent-soft/40' : 'border-line')}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-2">
                  <span className="tabular rounded border border-accent/30 bg-accent-soft px-1 font-mono text-[11px] font-semibold text-accent-strong">{e.ref}</span>
                  <span>{K.label}</span>
                  {e.occurredAt && <time dateTime={e.occurredAt}>{dateTime(e.occurredAt)}</time>}
                  {cited.has(e.ref) && <span className="rounded bg-good-soft px-1 text-[11px] font-medium text-good-ink">cited in report</span>}
                  {link && <Link href={link} className="ml-auto font-medium text-accent hover:underline">Open source</Link>}
                </div>
                <div className="mt-1 text-[13px] font-medium text-ink">{e.title}</div>
                <p className="mt-0.5 text-[13px] break-words text-ink-2">{e.summary}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default function InvestigationPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const { run, busy, error: actionError } = useAction();
  const [tab, setTab] = useState<'findings' | 'evidence' | 'steps'>('findings');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, isLoading } = useApi<Detail>(`/investigations/${id}`, {
    // Poll while the agent is working; stop once it has finished.
    refetchInterval: (q) => (q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 1500 : false),
  });

  const evidence = useMemo(() => new Map((data?.evidence ?? []).map((e) => [e.ref, e])), [data?.evidence]);
  const cited = useMemo(() => {
    const refs = new Set<string>();
    data?.hypotheses.forEach((h) => h.evidenceRefs.forEach((r) => refs.add(r)));
    data?.report?.facts.forEach((f) => f.evidenceRefs.forEach((r) => refs.add(r)));
    data?.report?.observations?.forEach((f) => f.evidenceRefs.forEach((r) => refs.add(r)));
    data?.report?.assessment?.supportingRefs.forEach((r) => refs.add(r));
    return refs;
  }, [data]);

  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Spinner label="Loading investigation" />;
  const running = data.status === 'QUEUED' || data.status === 'RUNNING';
  const report = data.report;
  const select = (ref: string) => {
    setSelected(ref);
    setTab('evidence');
    requestAnimationFrame(() => document.getElementById(`ev-${ref}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  return (
    <>
      <PageHeader
        back={{ href: '/investigations', label: 'Investigations' }}
        title={data.question}
        description={
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <InvestigationStatusBadge status={data.status} />
            {data.incident && <Link href={`/incidents/${data.incident.id}`} className="inline-flex items-center gap-1.5 hover:underline"><SeverityBadge severity={data.incident.severity} short />INC-{data.incident.number} · {data.incident.title}</Link>}
            <span>{data.createdBy?.name ?? 'Unknown'} · {timeAgo(data.createdAt)}</span>
            <EngineBadge mode={data.analysisMode} provider={data.provider} model={data.model} attemptedProvider={data.attemptedProvider} />
            {data.llmCalls > 0 && data.analysisMode === 'llm' && (
              <span className="tabular" title="Estimated from published list prices. The provider's console shows what was actually billed.">
                {data.llmCalls} model call{data.llmCalls === 1 ? '' : 's'} · {(data.inputTokens + data.cacheReadTokens).toLocaleString()} in / {data.outputTokens.toLocaleString()} out tokens · {(data.llmLatencyMs / 1000).toFixed(1)} s · {data.estimatedCostUsd == null ? 'cost unknown' : `est. $${data.estimatedCostUsd.toFixed(4)}`}
              </span>
            )}
          </span>
        }
        actions={running && session.can('investigation:run') && <Button loading={busy === 'cancel'} onClick={() => void run(() => api.post(`/investigations/${data.id}/cancel`), 'cancel')}>Cancel</Button>}
      />
      <FormError error={actionError} />

      {data.analysisMode === 'mock' && <div className="mb-4"><Notice tone="warn"><strong>This is mock output, not an analysis.</strong> AI_PROVIDER is set to mock: a scripted stand-in ran the pipeline and no model was called. Do not act on anything below.</Notice></div>}
      {data.analysisMode === 'heuristic' && data.attemptedProvider && data.attemptedProvider !== 'heuristic' && <div className="mb-4"><Notice tone="warn"><strong>The AI model could not be used for this investigation,</strong> so the rule-based engine analysed the evidence instead. The reason is listed under what is uncertain.</Notice></div>}
      {data.status === 'FAILED' && <div className="mb-4"><Notice tone="warn"><strong>This investigation failed.</strong> {data.error} Steps completed before the failure are kept below.</Notice></div>}
      {running && (
        <Card className="mb-4">
          <div className="flex items-center gap-3">
            <Sparkles className="size-5 animate-pulse text-accent" aria-hidden />
            <div role="status" aria-live="polite">
              <div className="text-sm font-medium">{data.steps.at(-1)?.title ?? 'Waiting for a worker to pick this up'}</div>
              <div className="text-[12px] text-ink-2">{data.steps.length} step{data.steps.length === 1 ? '' : 's'} · {data.evidence.length} evidence item{data.evidence.length === 1 ? '' : 's'} so far</div>
            </div>
          </div>
        </Card>
      )}

      {report && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Summary</h2>
            {/* With no fault hypothesis there is no hypothesis confidence to show; the assessment below carries its own. */}
            {data.hypotheses.length > 0 && <ConfidenceMeter value={report.confidence} />}
          </div>
          <p className="mt-2 max-w-4xl text-[15px] leading-relaxed text-ink"><WithRefs text={report.summary} evidence={evidence} onSelect={select} /></p>
          <p className="mt-3 flex items-start gap-1.5 text-[12px] text-ink-2">
            <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {report.analysisMode === 'heuristic' ? 'Produced by rule-based correlation, not a language model. ' : report.analysisMode === 'mock' ? 'Produced by a scripted mock, not a language model. ' : `Written by ${data.model ?? 'a language model'} from the evidence below. `}
            {data.hypotheses.length > 0 ? 'These are hypotheses to verify, not a confirmed root cause.' : 'No fault hypothesis was put forward.'}
          </p>
          {report.assessment && <div className="mt-4"><AssessmentCard assessment={report.assessment} renderRefs={(refs) => <Refs refs={refs} evidence={evidence} onSelect={select} />} /></div>}
          {report.integrity && <div className="mt-3"><IntegritySummary integrity={report.integrity} /></div>}
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'findings', label: 'Findings', count: data.hypotheses.length }, { id: 'evidence', label: 'Evidence timeline', count: data.evidence.length }, { id: 'steps', label: 'Agent steps', count: data.steps.length }]} />
          {tab === 'findings' && (
            !report ? <EmptyState title={running ? 'Findings appear when the investigation completes' : 'No findings'} description={running ? 'Follow progress under Agent steps.' : undefined} /> : (
              <div className="space-y-5">
                <section>
                  <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Hypotheses, most likely first</h3>
                  {data.hypotheses.length === 0 ? <p className="text-sm text-ink-2">{report.assessment?.outcome === 'HEALTHY' ? 'None: the evidence shows no fault to explain. A cause is not put forward when there is nothing to cause.' : 'No hypothesis met the evidence bar. See what could not be determined below.'}</p> : (
                    <div className="space-y-2">{data.hypotheses.map((h, i) => <HypothesisCard key={h.id} h={h} evidence={evidence} onSelect={select} top={i === 0} />)}</div>
                  )}
                </section>
                {report.facts.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-good-ink uppercase">Established facts</h3>
                    <ul className="space-y-1.5 text-sm">{report.facts.map((f, i) => <li key={i} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-good" /><span>{f.statement} <Refs refs={f.evidenceRefs} evidence={evidence} onSelect={select} /><VerificationMark verification={f.verification} /></span></li>)}</ul>
                  </section>
                )}
                {(report.observations?.length ?? 0) > 0 && (
                  <section>
                    <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Observations that are not evidence of a fault</h3>
                    <ul className="space-y-1.5 text-sm">{report.observations!.map((f, i) => <li key={i} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-line-strong" /><span>{f.statement} <Refs refs={f.evidenceRefs} evidence={evidence} onSelect={select} /><VerificationMark verification={f.verification} /></span></li>)}</ul>
                  </section>
                )}
                {report.assumptions.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-warn-ink uppercase">Assumptions</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm">{report.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </section>
                )}
                {report.uncertainties.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">What is uncertain or could not be checked</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{report.uncertainties.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </section>
                )}
                {report.timeline.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Sequence of events</h3>
                    <ol className="space-y-1 text-[13px]">{report.timeline.map((t, i) => <li key={i} className="grid grid-cols-[7.5rem_1fr] gap-2"><time className="tabular text-ink-2">{dateTime(t.timestamp)}</time><span>{t.description} <Refs refs={t.evidenceRefs} evidence={evidence} onSelect={select} /></span></li>)}</ol>
                  </section>
                )}
              </div>
            )
          )}
          {tab === 'evidence' && <EvidenceList items={data.evidence} selected={selected} cited={cited} />}
          {tab === 'steps' && (data.steps.length === 0 ? <EmptyState title="No steps yet" /> : <ol className="relative ml-3 border-l border-line">{data.steps.map((s) => <StepRow key={s.id} step={s} />)}</ol>)}
        </Card>

        <div className="space-y-4">
          {data.plan && (
            <Card title="Plan" description={data.plan.objective}>
              <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-ink">{data.plan.steps.map((s, i) => <li key={i}>{s.description} <Mono className="text-ink-3">{s.tool}</Mono></li>)}</ol>
              <p className="mt-3 text-[12px] text-ink-2">Window: {dateTime(data.plan.windowFrom)} to {dateTime(data.plan.windowTo)}{data.plan.services.length ? ` · ${data.plan.services.join(', ')}` : ''}</p>
            </Card>
          )}
          {report && report.nextSteps.length > 0 && (
            <Card title="Recommended next steps">
              <ol className="list-decimal space-y-1.5 pl-4 text-[13px]">{report.nextSteps.map((s, i) => <li key={i}><WithRefs text={s} evidence={evidence} onSelect={select} /></li>)}</ol>
            </Card>
          )}
          <Card title="Proposed remediation" description="Nothing runs without human approval" padded={false}>
            {data.remediations.length === 0 ? <p className="px-4 py-4 text-[13px] text-ink-2">{running ? 'Recommendations appear when the investigation completes.' : 'The investigation did not recommend a production change.'}</p> : (
              <ul>
                {data.remediations.map((r) => (
                  <li key={r.id} className="border-b border-line last:border-0">
                    <Link href={`/remediation/${r.id}`} className="block px-4 py-3 hover:bg-sunken/60">
                      <div className="text-sm font-medium">{r.title}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5"><RemediationStatusBadge status={r.status} /><EffectBadge effect={r.effect} /><RiskBadge risk={r.risk} /><span className="text-[12px] text-ink-2">{titleCase(r.type)}</span></div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
