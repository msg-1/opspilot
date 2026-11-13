'use client';

import { Bot, FileText, GitCommitHorizontal, MessageSquare, Rocket, Settings2, ShieldCheck, Sparkles, User } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfidenceMeter, DeploymentStatusBadge, IncidentStatusBadge, InvestigationStatusBadge, LevelTag, RemediationStatusBadge, RiskBadge, SeverityBadge } from '@/components/badges';
import { ProposeRemediation } from '@/components/propose-remediation';
import { Avatar, Button, Card, DefinitionList, EmptyState, ErrorState, Field, FormError, LinkButton, Modal, Mono, PageHeader, Select, Spinner, Tabs, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { dateTime, duration, timeAgo, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Deployment, IncidentDetail, Member } from '@/lib/types';

interface Context {
  window: { from: string; to: string };
  upstreamDependencies: { id: string; name: string; slug: string; health: string; kind: string }[];
  deployments: Deployment[];
  serviceEvents: { id: string; type: string; title: string; details: string | null; occurredAt: string; actor: string | null; service: { name: string } }[];
  errorPatterns: { fingerprint: string; sample: string; level: string; count: number; firstSeen: string; serviceName: string | null; serviceSlug: string | null }[];
  similarIncidents: { id: string; key: string; title: string; severity: string; status: string; rootCause: string | null; resolution: string | null; startedAt: string }[];
}

const STATUSES = ['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATED', 'RESOLVED', 'CLOSED'];
const EVENT_ICON: Record<string, React.ReactNode> = {
  comment: <MessageSquare className="size-3.5" aria-hidden />,
  investigation: <Sparkles className="size-3.5" aria-hidden />,
  remediation: <ShieldCheck className="size-3.5" aria-hidden />,
};

function Timeline({ incident, canWrite }: { incident: IncidentDetail; canWrite: boolean }) {
  const [message, setMessage] = useState('');
  const { run, busy, error } = useAction();
  return (
    <div>
      <ol className="relative ml-3 border-l border-line">
        {incident.timeline.map((e) => (
          <li key={e.id} className="relative pb-4 pl-6 last:pb-1">
            <span className={`absolute top-0.5 -left-[11px] flex size-[22px] items-center justify-center rounded-full border border-line bg-surface ${e.actorType === 'ai_agent' ? 'text-accent' : 'text-ink-2'}`}>
              {EVENT_ICON[e.type] ?? (e.actorType === 'ai_agent' ? <Bot className="size-3.5" aria-hidden /> : e.actorType === 'system' ? <Settings2 className="size-3.5" aria-hidden /> : <User className="size-3.5" aria-hidden />)}
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-2">
              <span className="font-medium text-ink">{e.actorLabel ?? 'System'}</span>
              <time dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()}>{timeAgo(e.createdAt)}</time>
            </div>
            {e.type === 'comment' ? (
              <p className="mt-1 rounded-lg border border-line bg-sunken/60 px-3 py-2 text-sm whitespace-pre-wrap">{e.message}</p>
            ) : (
              <p className="mt-0.5 text-sm text-ink">
                {e.message}
                {typeof e.metadata?.investigationId === 'string' && <Link href={`/investigations/${e.metadata.investigationId}`} className="ml-2 text-[13px] font-medium text-accent hover:underline">View investigation</Link>}
                {typeof e.metadata?.actionId === 'string' && <Link href={`/remediation/${e.metadata.actionId}`} className="ml-2 text-[13px] font-medium text-accent hover:underline">View action</Link>}
              </p>
            )}
          </li>
        ))}
      </ol>
      {canWrite && (
        <form
          className="mt-4 border-t border-line pt-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api.post(`/incidents/${incident.id}/comments`, { message }))) setMessage('');
          }}
        >
          <FormError error={error} />
          <Textarea aria-label="Add an update" rows={2} required maxLength={5000} placeholder="Add an update. Mention a teammate with @Full Name to notify them." value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="mt-2 flex justify-end"><Button type="submit" variant="primary" size="sm" loading={!!busy} disabled={!message.trim()}>Post update</Button></div>
        </form>
      )}
    </div>
  );
}

function ContextView({ id }: { id: string }) {
  const { data, error, isLoading } = useApi<Context>(`/incidents/${id}/context`);
  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Spinner label="Gathering related changes" />;
  const nothing = !data.deployments.length && !data.serviceEvents.length && !data.errorPatterns.length && !data.similarIncidents.length;
  if (nothing) return <EmptyState title="Nothing related was recorded" description="No deployments, service events or error logs exist for the affected services in the 24 hours before this incident. Link the affected services, or send deployments and logs to OPSILUME." />;
  const H = ({ children }: { children: React.ReactNode }) => <h3 className="mt-5 mb-2 text-[12px] font-semibold tracking-wide text-ink-2 uppercase first:mt-0">{children}</h3>;
  return (
    <div>
      <p className="mb-4 text-[13px] text-ink-2">Changes to the affected services and their upstream dependencies between {dateTime(data.window.from)} and {dateTime(data.window.to)}.</p>
      {data.deployments.length > 0 && (
        <>
          <H>Deployments before and during the incident</H>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.deployments.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <Rocket className="size-4 text-ink-3" aria-hidden />
                <span className="font-medium">{d.service.name}</span>
                <Mono>{d.version}</Mono>
                <DeploymentStatusBadge status={d.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{d.description}</span>
                <span className="text-[12px] text-ink-2">{dateTime(d.startedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.errorPatterns.length > 0 && (
        <>
          <H>Most frequent error patterns</H>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.errorPatterns.slice(0, 6).map((p) => (
              <li key={p.fingerprint + p.serviceSlug} className="px-3 py-2">
                <div className="flex items-center gap-2 text-[12px] text-ink-2"><LevelTag level={p.level} /><span className="tabular font-semibold text-ink">{p.count}×</span>{p.serviceName} · first seen {dateTime(p.firstSeen)}
                  <Link href={`/logs?fingerprint=${p.fingerprint}&from=24h`} className="ml-auto font-medium text-accent hover:underline">Open in logs</Link>
                </div>
                <Mono className="mt-1 block break-all text-ink">{p.sample}</Mono>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.serviceEvents.length > 0 && (
        <>
          <H>Operational events</H>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.serviceEvents.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-sm">
                <GitCommitHorizontal className="size-4 text-ink-3" aria-hidden />
                <span className="text-[12px] text-ink-2">{titleCase(e.type)}</span>
                <span className="min-w-0 flex-1"><span className="font-medium">{e.service.name}</span>: {e.title}</span>
                <span className="text-[12px] text-ink-2">{dateTime(e.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.similarIncidents.length > 0 && (
        <>
          <H>Similar past incidents</H>
          <ul className="space-y-2">
            {data.similarIncidents.map((s) => (
              <li key={s.id} className="rounded-lg border border-line px-3 py-2">
                <Link href={`/incidents/${s.id}`} className="text-sm font-medium hover:underline"><Mono className="mr-2 text-ink-2">{s.key}</Mono>{s.title}</Link>
                {s.rootCause && <p className="mt-1 text-[13px] text-ink-2"><span className="font-medium text-ink">Root cause:</span> {s.rootCause}</p>}
                {s.resolution && <p className="mt-0.5 text-[13px] text-ink-2"><span className="font-medium text-ink">Resolution:</span> {s.resolution}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Findings({ incident, canWrite }: { incident: IncidentDetail; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ rootCause: incident.rootCause ?? '', resolution: incident.resolution ?? '', customerImpact: incident.customerImpact ?? '' });
  const { run, busy, error } = useAction();
  const Block = ({ label, value }: { label: string; value: string | null }) => (
    <div>
      <div className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">{label}</div>
      <p className="mt-1 text-sm whitespace-pre-wrap">{value || <span className="text-ink-3">Not recorded yet</span>}</p>
    </div>
  );
  if (!editing) {
    return (
      <div className="space-y-4">
        <Block label="Customer impact" value={incident.customerImpact} />
        <Block label="Root cause (confirmed by the team)" value={incident.rootCause} />
        <Block label="Resolution" value={incident.resolution} />
        {canWrite && <Button size="sm" onClick={() => setEditing(true)}>Edit findings</Button>}
      </div>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.patch(`/incidents/${incident.id}`, { rootCause: form.rootCause || null, resolution: form.resolution || null, customerImpact: form.customerImpact || null }))) setEditing(false);
      }}
    >
      <FormError error={error} />
      <Field label="Customer impact">{(id) => <Textarea id={id} rows={2} value={form.customerImpact} onChange={(e) => setForm({ ...form, customerImpact: e.target.value })} />}</Field>
      <Field label="Root cause" hint="Record this once the team has verified it. AI hypotheses are not confirmed causes.">{(id) => <Textarea id={id} rows={3} value={form.rootCause} onChange={(e) => setForm({ ...form, rootCause: e.target.value })} />}</Field>
      <Field label="Resolution">{(id) => <Textarea id={id} rows={3} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} />}</Field>
      <div className="flex gap-2"><Button type="submit" variant="primary" size="sm" loading={!!busy}>Save</Button><Button size="sm" onClick={() => setEditing(false)}>Cancel</Button></div>
    </form>
  );
}

export default function IncidentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const canWrite = session.can('incident:write');
  const { data: incident, error, isLoading, refetch } = useApi<IncidentDetail>(`/incidents/${id}`, { refetchInterval: 15_000 });
  const members = useApi<{ data: Member[] }>(canWrite ? '/members' : null);
  const { run, busy, error: actionError } = useAction();
  const [tab, setTab] = useState<'timeline' | 'context' | 'findings'>('timeline');
  const [asking, setAsking] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [question, setQuestion] = useState('');

  if (error) return <ErrorState error={error} retry={() => void refetch()} />;
  if (isLoading || !incident) return <Spinner label="Loading incident" />;
  const patch = (body: Record<string, unknown>, key: string) => run(() => api.patch(`/incidents/${incident.id}`, body), key);
  const defaultQuestion = `What is the most likely cause of "${incident.title}", and what changed before it started?`;

  return (
    <>
      <PageHeader
        back={{ href: '/incidents', label: 'Incidents' }}
        title={<span className="flex flex-wrap items-center gap-x-3 gap-y-1"><Mono className="text-base text-ink-2">{incident.key}</Mono>{incident.title}</span>}
        description={<span className="mt-1 flex flex-wrap items-center gap-2"><SeverityBadge severity={incident.severity} /><IncidentStatusBadge status={incident.status} /><span>Started {dateTime(incident.startedAt)} · {incident.resolvedAt ? `lasted ${duration(incident.durationMinutes)}` : `ongoing for ${duration(incident.durationMinutes)}`}</span></span>}
        actions={
          <>
            {session.can('investigation:run') && <Button variant="primary" icon={<Sparkles className="size-4" aria-hidden />} onClick={() => { setQuestion(defaultQuestion); setAsking(true); }}>Investigate with AI</Button>}
            {canWrite && (
              <Select aria-label="Change status" className="w-44" value={incident.status} disabled={busy === 'status'} onChange={(e) => void patch({ status: e.target.value }, 'status')}>
                {STATUSES.map((s) => <option key={s} value={s} disabled={s === 'CLOSED' && incident.status !== 'RESOLVED' && incident.status !== 'CLOSED'}>{titleCase(s)}</option>)}
              </Select>
            )}
          </>
        }
      />
      <FormError error={actionError} />
      {incident.description && <p className="mb-4 max-w-4xl text-sm whitespace-pre-wrap text-ink-2">{incident.description}</p>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'timeline', label: 'Timeline', count: incident.timeline.length }, { id: 'context', label: 'Related changes' }, { id: 'findings', label: 'Findings' }]} />
          {tab === 'timeline' && <Timeline incident={incident} canWrite={canWrite} />}
          {tab === 'context' && <ContextView id={incident.id} />}
          {tab === 'findings' && <Findings incident={incident} canWrite={canWrite} />}
        </Card>

        <div className="space-y-4">
          <Card title="Details">
            <DefinitionList
              items={[
                ['Assignee', canWrite ? (
                  <Select aria-label="Assignee" className="h-8" value={incident.assignee?.id ?? ''} onChange={(e) => void patch({ assigneeId: e.target.value || null }, 'assignee')}>
                    <option value="">Unassigned</option>
                    {members.data?.data.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                  </Select>
                ) : incident.assignee?.name ?? 'Unassigned'],
                ['Commander', canWrite ? (
                  <Select aria-label="Incident commander" className="h-8" value={incident.commander?.id ?? ''} onChange={(e) => void patch({ commanderId: e.target.value || null }, 'commander')}>
                    <option value="">None</option>
                    {members.data?.data.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                  </Select>
                ) : incident.commander?.name ?? 'None'],
                ['Severity', canWrite ? (
                  <Select aria-label="Severity" className="h-8" value={incident.severity} onChange={(e) => void patch({ severity: e.target.value }, 'severity')}>
                    {['SEV1', 'SEV2', 'SEV3', 'SEV4'].map((s) => <option key={s}>{s}</option>)}
                  </Select>
                ) : incident.severity],
                ['Services', incident.services.length ? <span className="flex flex-wrap gap-1">{incident.services.map((s) => <Link key={s.id} href={`/services/${s.id}`} className="rounded bg-sunken px-1.5 py-0.5 text-[13px] hover:underline">{s.name}</Link>)}</span> : '—'],
                ['Source', titleCase(incident.source)],
                ['Acknowledged', incident.acknowledgedAt ? dateTime(incident.acknowledgedAt) : '—'],
                ['Resolved', incident.resolvedAt ? dateTime(incident.resolvedAt) : '—'],
                ['Opened by', incident.createdBy ? <span className="flex items-center gap-1.5"><Avatar name={incident.createdBy.name} size={18} />{incident.createdBy.name}</span> : 'Monitoring'],
              ]}
            />
          </Card>

          <Card title="AI investigations" padded={false}>
            {incident.investigations.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-ink-2">None yet. An investigation gathers logs, deployments, code changes and metrics around this incident and ranks possible causes with cited evidence.</p>
            ) : (
              <ul>
                {incident.investigations.map((i) => (
                  <li key={i.id} className="border-b border-line last:border-0">
                    <Link href={`/investigations/${i.id}`} className="block px-4 py-3 hover:bg-sunken/60">
                      <div className="flex items-center justify-between gap-2"><InvestigationStatusBadge status={i.status} /><span className="text-[12px] text-ink-3">{timeAgo(i.createdAt)}</span></div>
                      <p className="mt-1.5 line-clamp-3 text-[13px] text-ink-2">{i.summary ?? i.question}</p>
                      {i.confidence !== null && <div className="mt-2"><ConfidenceMeter value={i.confidence} /></div>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Remediation" padded={false} actions={session.can('remediation:propose') && <Button size="sm" onClick={() => setProposing(true)}>Propose action</Button>}>
            {incident.remediations.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-ink-2">No actions proposed. Any change to production goes through approval here first.</p>
            ) : (
              <ul>
                {incident.remediations.map((r) => (
                  <li key={r.id} className="border-b border-line last:border-0">
                    <Link href={`/remediation/${r.id}`} className="block px-4 py-3 hover:bg-sunken/60">
                      <div className="text-sm font-medium">{r.title}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><RemediationStatusBadge status={r.status} /><RiskBadge risk={r.risk} />{r.proposedByType === 'ai_agent' && <span className="flex items-center gap-1 text-[12px] text-ink-2"><Bot className="size-3" aria-hidden />Proposed by AI</span>}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Postmortem">
            {incident.postmortem ? (
              <LinkButton href={`/knowledge/${incident.postmortem.id}`} icon={<FileText className="size-4" aria-hidden />}>Open postmortem</LinkButton>
            ) : (
              <>
                <p className="mb-3 text-[13px] text-ink-2">Creates a draft from the recorded timeline, findings and actions, and adds it to the knowledge base so future investigations can find it.</p>
                {session.can('knowledge:write') && (
                  <Button loading={busy === 'pm'} icon={<FileText className="size-4" aria-hidden />} onClick={async () => { const r = await run(() => api.post<{ id: string }>(`/incidents/${incident.id}/postmortem`), 'pm'); if (r) router.push(`/knowledge/${r.id}`); }}>
                    Draft postmortem
                  </Button>
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      <Modal open={asking} onClose={() => setAsking(false)} title={`Investigate ${incident.key}`} wide footer={<><Button onClick={() => setAsking(false)}>Cancel</Button><Button variant="primary" loading={busy === 'ask'} disabled={question.trim().length < 8} onClick={async () => { const r = await run(() => api.post<{ id: string }>('/investigations', { question, incidentId: incident.id }), 'ask'); if (r) router.push(`/investigations/${r.id}`); }}>Start investigation</Button></>}>
        <Field label="What should be investigated?" hint="The investigation is read-only. It may propose remediation actions, which always need human approval.">
          {(fid) => <Textarea id={fid} rows={4} value={question} onChange={(e) => setQuestion(e.target.value)} />}
        </Field>
      </Modal>
      <ProposeRemediation open={proposing} onClose={() => setProposing(false)} incidentId={incident.id} services={incident.services} />
    </>
  );
}
