'use client';

import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { EffectBadge, OutcomeBadge, RiskBadge } from '@/components/badges';
import { VerificationMark } from '@/components/findings';
import { Button, ErrorState, LinkButton, Notice, Spinner } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dateTime, percent, titleCase } from '@/lib/format';
import type { Evidence, InvestigationDetail, RemediationList } from '@/lib/types';

/**
 * The investigation as a document for someone who was not there: what happened, what is most
 * likely, how sure that is, what it rests on, and what to do next. It shows only what the
 * stored report and evidence contain. Nothing is computed, summarised or filled in here, and
 * it reads the same on paper (the browser's print dialog saves it as a PDF).
 */

const OUTCOME_MEANS: Record<string, string> = {
  INCIDENT: 'A failure is evident in the data, and at least one explanation is supported by evidence.',
  DEGRADED: 'Something measurable is wrong, but the evidence does not establish what caused it.',
  HEALTHY: 'No material evidence of a fault was found in the period examined.',
  UNDETERMINED: 'There was not enough data to conclude either that there was a fault or that there was none.',
};
const KIND: Record<string, string> = {
  deployment: 'Deployment', deployment_impact: 'Deployment impact', service_event: 'Change event', commit: 'Commit', pull_request: 'Pull request',
  log_pattern: 'Log pattern', log: 'Log line', metric: 'Metric', metric_baseline: 'Metric (steady)', alert: 'Alert', dependency: 'Dependency',
  service_health: 'Service health', incident: 'Past incident', document: 'Runbook or document', trace: 'Trace',
};
const CHANGE_KINDS = new Set(['deployment', 'service_event', 'commit', 'pull_request']);
const confidenceWord = (c: number) => (c >= 0.75 ? 'high' : c >= 0.5 ? 'moderate' : c >= 0.25 ? 'low' : 'very low');

/** Marks what kind of statement a section holds, so that a fact is never read as a guess or the other way round. */
function Kind({ children, tone }: { children: ReactNode; tone: 'fact' | 'hypothesis' | 'recommendation' | 'unknown' }) {
  const cls = { fact: 'border-good/40 bg-good-soft text-good-ink', hypothesis: 'border-accent/30 bg-accent-soft text-accent-strong', recommendation: 'border-warn/50 bg-warn-soft text-warn-ink', unknown: 'border-line bg-sunken text-ink-2' }[tone];
  return <span className={`ml-2 rounded border px-1.5 py-0.5 align-middle text-[11px] font-semibold tracking-wide uppercase ${cls}`}>{children}</span>;
}

function Section({ id, title, kind, children }: { id: string; title: string; kind?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-7 break-inside-avoid-page">
      <h2 id={id} className="border-b border-line pb-1 text-[17px] font-semibold text-ink">{title}{kind}</h2>
      <div className="mt-3 space-y-3 text-[14px] leading-6 text-ink">{children}</div>
    </section>
  );
}

function Refs({ refs, known }: { refs: string[]; known: Map<string, Evidence> }) {
  const present = refs.filter((r) => known.has(r));
  if (!present.length) return null;
  return <span className="ml-1 text-[12px] text-ink-3">[{present.map((r, i) => <span key={r}>{i > 0 && ', '}<a href={`#evidence-${r}`} className="underline-offset-2 hover:underline">{r}</a></span>)}]</span>;
}

function EvidenceList({ refs, known, empty }: { refs: string[]; known: Map<string, Evidence>; empty: string }) {
  const items = refs.map((r) => known.get(r)).filter((e): e is Evidence => !!e);
  if (!items.length) return <p className="text-ink-2">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((e) => <li key={e.ref}>{e.title}{e.occurredAt && <span className="text-ink-2"> ({dateTime(e.occurredAt)})</span>} <Refs refs={[e.ref]} known={known} /></li>)}
    </ul>
  );
}

const Bullets = ({ items }: { items: string[] }) => <ul className="list-disc space-y-1 pl-5">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>;

export default function InvestigationReportPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading } = useApi<InvestigationDetail>(`/investigations/${id}`);
  const actions = useApi<RemediationList>(`/remediations?investigationId=${id}&pageSize=50`);
  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Spinner label="Loading report" />;

  const report = data.report;
  const known = new Map(data.evidence.map((e) => [e.ref, e]));
  const assessment = report?.assessment ?? null;
  const outcome = assessment?.outcome ?? data.outcome ?? null;
  const [leading, ...others] = data.hypotheses;
  const cited = new Set<string>([
    ...data.hypotheses.flatMap((h) => [...h.evidenceRefs, ...h.contradictingRefs]),
    ...(report?.facts ?? []).flatMap((f) => f.evidenceRefs),
    ...(report?.observations ?? []).flatMap((f) => f.evidenceRefs),
    ...(report?.timeline ?? []).flatMap((t) => t.evidenceRefs),
    ...(assessment?.supportingRefs ?? []),
  ]);
  const changes = data.evidence.filter((e) => CHANGE_KINDS.has(e.kind)).sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
  const citedEvidence = data.evidence.filter((e) => cited.has(e.ref) || CHANGE_KINDS.has(e.kind));
  const engine =
    data.analysisMode === 'llm'
      ? `Written by an AI model (${[data.provider, data.model].filter(Boolean).join(' ')}) from the evidence listed below, and checked against it.`
      : data.analysisMode === 'mock'
        ? 'Written by a scripted stand-in used for testing. It is not an analysis.'
        : 'Written by the rule-based engine from the evidence listed below. No AI model was used.';

  return (
    <article className="mx-auto max-w-[820px] rounded-lg border border-line bg-surface px-6 py-7 sm:px-10 print:max-w-none print:border-0 print:p-0">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <LinkButton href={`/investigations/${data.id}`} size="sm" icon={<ArrowLeft className="size-3.5" aria-hidden />}>Back to the investigation</LinkButton>
        <Button size="sm" variant="primary" icon={<Printer className="size-3.5" aria-hidden />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>

      <header>
        <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Investigation report</p>
        <h1 className="mt-1 text-[24px] leading-8 font-semibold text-ink">{data.incident ? `INC-${data.incident.number}: ${data.incident.title}` : data.question}</h1>
        {data.incident && <p className="mt-1 text-[14px] text-ink-2">Question investigated: {data.question}</p>}
        <p className="mt-2 text-[13px] text-ink-2">
          {data.completedAt ? `Completed ${dateTime(data.completedAt)}` : `Started ${dateTime(data.createdAt)}`}
          {data.createdBy ? ` · requested by ${data.createdBy.name}` : ''}
          {data.incident ? ` · severity ${data.incident.severity}` : ''}
        </p>
        <p className="mt-1 text-[13px] text-ink-2" data-testid="engine-line">{engine}</p>
      </header>

      {data.analysisMode === 'mock' && <div className="mt-4"><Notice tone="warn"><strong>This is test output.</strong> Do not act on anything in it.</Notice></div>}
      {data.status === 'FAILED' && <div className="mt-4"><Notice tone="warn"><strong>This investigation failed and reached no conclusion.</strong> {data.error}</Notice></div>}
      {data.status === 'CANCELLED' && <div className="mt-4"><Notice tone="warn"><strong>This investigation was cancelled and reached no conclusion.</strong></Notice></div>}
      {(data.status === 'QUEUED' || data.status === 'RUNNING') && <div className="mt-4"><Notice><strong>This investigation is still running.</strong> The report appears when it has finished.</Notice></div>}

      {report && (
        <>
          <div className="mt-4"><Notice>This report says what the evidence shows and what is most likely. <strong>The cause has not been confirmed</strong>: treat it as a hypothesis until someone has verified it.</Notice></div>

          <Section id="conclusion" title="Conclusion">
            {outcome && (
              <p><OutcomeBadge outcome={outcome} /> <span className="ml-1">{OUTCOME_MEANS[outcome]}</span></p>
            )}
            {assessment?.rationale && <p>{assessment.rationale} <Refs refs={assessment.supportingRefs} known={known} /></p>}
            <dl className="grid grid-cols-[minmax(150px,auto)_1fr] gap-x-4 gap-y-1.5 text-[14px]">
              {data.plan?.services?.length ? <><dt className="text-ink-2">Services examined</dt><dd>{data.plan.services.join(', ')}</dd></> : null}
              {data.plan?.windowFrom && data.plan.windowTo ? <><dt className="text-ink-2">Period examined</dt><dd>{dateTime(data.plan.windowFrom)} to {dateTime(data.plan.windowTo)}</dd></> : null}
              {assessment && outcome !== 'UNDETERMINED' && <><dt className="text-ink-2">Confidence in this conclusion</dt><dd>{percent(assessment.confidence)} ({confidenceWord(assessment.confidence)}). It reflects how much data could be examined and how strong the signals are.</dd></>}
              {report.integrity && report.integrity.checked > 0 && <><dt className="text-ink-2">Figures checked</dt><dd>{report.integrity.supported} of {report.integrity.checked} numbers, times and identifiers in this report match the evidence they cite.</dd></>}
            </dl>
          </Section>

          <Section id="cause" title="Most probable cause" kind={<Kind tone="hypothesis">Hypothesis</Kind>}>
            {leading ? (
              <>
                <p className="text-[15px] font-semibold">{leading.title}</p>
                <p className="text-ink-2">Confidence in this explanation: {percent(leading.confidence)} ({confidenceWord(leading.confidence)}; rated {leading.status}). This is separate from the confidence in the conclusion above.</p>
                <p>{leading.description}</p>
                <div>
                  <h3 className="text-[13px] font-semibold text-ink-2">Evidence that supports it</h3>
                  <EvidenceList refs={leading.evidenceRefs} known={known} empty="No evidence item is cited for it." />
                </div>
                <div>
                  <h3 className="text-[13px] font-semibold text-ink-2">Evidence against it</h3>
                  {leading.contradictions.length || leading.contradictingRefs.length ? (
                    <>
                      {leading.contradictions.length > 0 && <Bullets items={leading.contradictions} />}
                      <EvidenceList refs={leading.contradictingRefs} known={known} empty="" />
                    </>
                  ) : (
                    <p className="text-ink-2">Nothing in the evidence gathered contradicts it. That is not the same as having looked for and excluded every alternative.</p>
                  )}
                </div>
                {leading.assumptions.length > 0 && <div><h3 className="text-[13px] font-semibold text-ink-2">Assumed, not verified</h3><Bullets items={leading.assumptions} /></div>}
                {leading.gaps.length > 0 && <div><h3 className="text-[13px] font-semibold text-ink-2">What would confirm or refute it</h3><Bullets items={leading.gaps} /></div>}
              </>
            ) : (
              <p>{outcome === 'HEALTHY' ? 'No cause is proposed, because the evidence shows no fault.' : outcome === 'UNDETERMINED' ? 'No cause is proposed: there was too little data to support one.' : 'The evidence does not support any explanation well enough to propose one.'}</p>
            )}
            {others.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-ink-2">Other explanations considered</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {others.map((h) => <li key={h.id}><span className="font-medium">{h.title}</span> <span className="text-ink-2">({percent(h.confidence)}, {h.status})</span> <Refs refs={h.evidenceRefs} known={known} /></li>)}
                </ul>
              </div>
            )}
          </Section>

          <Section id="facts" title="What is established" kind={<Kind tone="fact">Facts</Kind>}>
            {report.facts.length ? (
              <ul className="list-disc space-y-1.5 pl-5">
                {report.facts.map((f, i) => <li key={i}>{f.statement} <Refs refs={f.evidenceRefs} known={known} /><VerificationMark verification={f.verification} /></li>)}
              </ul>
            ) : <p className="text-ink-2">The report states no fact beyond the conclusion above.</p>}
            {(report.observations?.length ?? 0) > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-ink-2">Noticed, but not evidence of a fault</h3>
                <ul className="list-disc space-y-1.5 pl-5">{report.observations!.map((f, i) => <li key={i}>{f.statement} <Refs refs={f.evidenceRefs} known={known} /></li>)}</ul>
              </div>
            )}
          </Section>

          <Section id="changes" title="Deployments and changes in the evidence" kind={<Kind tone="fact">Facts</Kind>}>
            {changes.length ? (
              <table className="w-full text-left text-[13px]">
                <thead><tr className="border-b border-line text-ink-2"><th className="py-1 pr-3 font-medium">When</th><th className="py-1 pr-3 font-medium">Kind</th><th className="py-1 font-medium">What</th></tr></thead>
                <tbody>{changes.map((e) => <tr key={e.ref} className="border-b border-line/60 align-top"><td className="py-1 pr-3 whitespace-nowrap">{e.occurredAt ? dateTime(e.occurredAt) : 'Time not recorded'}</td><td className="py-1 pr-3 whitespace-nowrap">{KIND[e.kind] ?? titleCase(e.kind)}</td><td className="py-1">{e.title} <Refs refs={[e.ref]} known={known} /></td></tr>)}</tbody>
              </table>
            ) : <p className="text-ink-2">No deployment, configuration change, commit or pull request is among the evidence gathered.{assessment?.missingTelemetry.some((m) => /deployment/i.test(m)) ? ' Deployment history was not examined.' : ''}</p>}
          </Section>

          <Section id="unknown" title="What is not known" kind={<Kind tone="unknown">Limits</Kind>}>
            {!report.uncertainties.length && !assessment?.missingTelemetry.length && !report.integrity?.flagged.length && <p className="text-ink-2">The report lists no open question.</p>}
            {report.uncertainties.length > 0 && <div><h3 className="text-[13px] font-semibold text-ink-2">Uncertain, or could not be checked</h3><Bullets items={report.uncertainties} /></div>}
            {(assessment?.missingTelemetry.length ?? 0) > 0 && <div><h3 className="text-[13px] font-semibold text-ink-2">Not examined, or no data</h3><Bullets items={assessment!.missingTelemetry} /></div>}
            {(report.integrity?.flagged.length ?? 0) > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-critical-ink">Figures in this report that the evidence does not support</h3>
                <ul className="list-disc space-y-1 pl-5">{report.integrity!.flagged.map((f, i) => <li key={i}><span className="font-mono">{f.text}</span> in {f.where}: {f.detail}</li>)}</ul>
              </div>
            )}
          </Section>

          <Section id="next" title="Recommended next steps" kind={<Kind tone="recommendation">Recommendations</Kind>}>
            {report.nextSteps.length ? <ol className="list-decimal space-y-1 pl-5">{report.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ol> : <p className="text-ink-2">The report recommends no further step.</p>}
            <div>
              <h3 className="text-[13px] font-semibold text-ink-2">Proposed actions</h3>
              {actions.data?.data.length ? (
                <>
                  <ul className="space-y-2">
                    {actions.data.data.map((a) => (
                      <li key={a.id} className="rounded-md border border-line px-3 py-2">
                        <p className="font-medium"><Link href={`/remediation/${a.id}`} className="underline-offset-2 hover:underline">{a.title}</Link></p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                          <EffectBadge effect={a.effect} /><RiskBadge risk={a.risk} />
                          <span>{a.effect === 'read_only' ? 'Needs no approval: it changes nothing.' : `Needs ${a.requiredApprovals} approval${a.requiredApprovals === 1 ? '' : 's'} before it may be carried out${a.risk === 'HIGH' ? ', from an admin or owner' : ''}; ${a.approvalsGranted} given.`}</span>
                          <span>Status: {titleCase(a.status)}.</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[13px] text-ink-2">OPSILUME does not carry out any of these by itself. A person approves each change, and a person or your own automation performs it.</p>
                </>
              ) : <p className="text-ink-2">{actions.isLoading ? 'Loading…' : 'No action was proposed. Nothing that would change a production system is recommended on this evidence.'}</p>}
            </div>
          </Section>

          {report.timeline.length > 0 && (
            <Section id="sequence" title="Sequence of events" kind={<Kind tone="fact">Facts</Kind>}>
              <table className="w-full text-left text-[13px]">
                <tbody>{report.timeline.map((t, i) => <tr key={i} className="border-b border-line/60 align-top"><td className="py-1 pr-3 whitespace-nowrap">{dateTime(t.timestamp)}</td><td className="py-1">{t.description} <Refs refs={t.evidenceRefs} known={known} /></td></tr>)}</tbody>
              </table>
            </Section>
          )}

          <Section id="evidence" title="Evidence referred to">
            <p className="text-[13px] text-ink-2">Each item is a record in your own data (a log pattern, a metric, a deployment, an alert). {data.evidence.length - citedEvidence.length > 0 ? `${data.evidence.length - citedEvidence.length} further item${data.evidence.length - citedEvidence.length === 1 ? ' was' : 's were'} gathered and not referred to; all ${data.evidence.length} are on the investigation page.` : ''}</p>
            <ul className="space-y-2">
              {citedEvidence.map((e) => (
                <li key={e.ref} id={`evidence-${e.ref}`} className="break-inside-avoid text-[13px]">
                  <p><span className="font-mono font-semibold">{e.ref}</span> · {KIND[e.kind] ?? titleCase(e.kind)}{e.occurredAt ? ` · ${dateTime(e.occurredAt)}` : ''}</p>
                  <p className="font-medium">{e.title}</p>
                  <p className="text-ink-2">{e.summary}</p>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </article>
  );
}
