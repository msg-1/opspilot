'use client';

import clsx from 'clsx';
import { Bot, Check, CheckCircle2, Circle, X, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EffectBadge, RemediationStatusBadge, RiskBadge, SeverityBadge } from '@/components/badges';
import { Avatar, Button, Card, DefinitionList, ErrorState, Field, FormError, Modal, Mono, Notice, PageHeader, Spinner, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { dateTime, timeAgo, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Remediation } from '@/lib/types';

const STAGES = ['Proposed', 'Awaiting approval', 'Approved', 'Executed'];
const STAGE_INDEX: Record<string, number> = { PROPOSED: 0, PENDING_APPROVAL: 1, APPROVED: 2, EXECUTING: 2, FAILED: 2, EXECUTED: 3 };

function Progress({ status }: { status: string }) {
  const stopped = status === 'REJECTED' || status === 'CANCELLED';
  const current = STAGE_INDEX[status] ?? 1;
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" aria-label="Approval progress">
      {STAGES.map((s, i) => {
        const done = !stopped && (i < current || status === 'EXECUTED');
        const active = !stopped && i === current && status !== 'EXECUTED';
        return (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className={clsx('h-px w-6', done || active ? 'bg-ink' : 'bg-line-strong')} />}
            <span className={clsx('flex items-center gap-1.5', done ? 'text-ink' : active ? 'font-semibold text-ink' : 'text-ink-3')} aria-current={active ? 'step' : undefined}>
              {done ? <CheckCircle2 className="size-4 text-good-ink" aria-hidden /> : <Circle className={clsx('size-4', active && 'fill-accent-soft text-accent')} aria-hidden />}
              {s}
            </span>
          </li>
        );
      })}
      {stopped && <li className="flex items-center gap-1.5 font-semibold text-critical-ink"><XCircle className="size-4" aria-hidden />{titleCase(status)}</li>}
    </ol>
  );
}

export default function RemediationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const { data: a, error, isLoading } = useApi<Remediation>(`/remediations/${id}`, { refetchInterval: 10_000 });
  const { run, busy, error: actionError } = useAction();
  const [dialog, setDialog] = useState<null | 'approve' | 'reject' | 'execute' | 'retry'>(null);
  const [comment, setComment] = useState('');

  if (error) return <ErrorState error={error} />;
  if (isLoading || !a) return <Spinner label="Loading action" />;

  const base = `/remediations/${a.id}`;
  const act = async (path: string, body: Record<string, unknown>, key: string) => {
    if (await run(() => api.post(`${base}/${path}`, body), key)) {
      setDialog(null);
      setComment('');
    }
  };
  const me = session.user.id;
  const involved = a.requestedBy?.id === me || a.proposedBy?.id === me;
  const alreadyDecided = a.approvals.some((x) => x.approver?.id === me && !x.supersededAt);
  const readOnly = a.effect === 'read_only';
  const outcomeUnknown = a.status === 'FAILED' && a.executionResult?.outcome !== 'not_applied';
  const canApproveRole = session.can('remediation:approve') && (a.risk !== 'HIGH' || session.can('remediation:approve:high'));
  const selfBlocked = involved && !a.allowSelfApproval;
  const manual = a.executionMode !== 'webhook';

  let blocker: string | null = null;
  if (a.status === 'PENDING_APPROVAL') {
    if (!session.can('remediation:approve')) blocker = 'Your role cannot approve remediation actions.';
    else if (!canApproveRole) blocker = 'High-risk actions must be approved by an admin or owner.';
    else if (alreadyDecided) blocker = 'You have already recorded your decision.';
    else if (selfBlocked) blocker = 'You proposed or requested this action, so someone else must approve it.';
  }

  return (
    <>
      <PageHeader
        back={{ href: '/remediation', label: 'Approvals' }}
        title={a.title}
        description={<span className="mt-1 flex flex-wrap items-center gap-2"><RemediationStatusBadge status={a.status} /><EffectBadge effect={a.effect} /><RiskBadge risk={a.risk} /><span>{titleCase(a.type)}{a.service ? ` on ${a.service.name}` : ''}</span></span>}
        actions={
          <>
            {a.status === 'PROPOSED' && !readOnly && session.can('remediation:propose') && <Button variant="primary" loading={busy === 'request'} onClick={() => void act('request-approval', {}, 'request')}>Submit for approval</Button>}
            {a.status === 'PROPOSED' && readOnly && session.can('remediation:execute') && <Button variant="primary" onClick={() => setDialog('execute')}>Record as done</Button>}
            {a.status === 'PENDING_APPROVAL' && !blocker && (
              <>
                <Button icon={<X className="size-4" aria-hidden />} onClick={() => setDialog('reject')}>Reject</Button>
                <Button variant="primary" icon={<Check className="size-4" aria-hidden />} onClick={() => setDialog('approve')}>Approve</Button>
              </>
            )}
            {a.status === 'APPROVED' && session.can('remediation:execute') && <Button variant="primary" onClick={() => setDialog('execute')}>{readOnly ? 'Record as done' : manual ? 'Mark as executed' : 'Execute'}</Button>}
            {a.status === 'FAILED' && !outcomeUnknown && session.can('remediation:execute') && <Button loading={busy === 'retry'} onClick={() => void act('retry', {}, 'retry')}>Retry</Button>}
            {outcomeUnknown && session.can('remediation:execute') && <Button variant="danger" onClick={() => setDialog('retry')}>Retry…</Button>}
            {['PROPOSED', 'PENDING_APPROVAL', 'APPROVED'].includes(a.status) && session.can('remediation:propose') && <Button variant="ghost" loading={busy === 'cancel'} onClick={() => void act('cancel', {}, 'cancel')}>Cancel action</Button>}
          </>
        }
      />
      <FormError error={actionError} />
      <Card className="mb-4"><Progress status={a.status} /></Card>
      {blocker && <div className="mb-4"><Notice tone="warn">{blocker}</Notice></div>}
      {outcomeUnknown && <div className="mb-4"><Notice tone="warn"><strong>The outcome of the last attempt is unknown.</strong> The request was sent, but no clear answer came back, so the change may or may not have been applied. Check the target system before retrying: a retry could apply it a second time.</Notice></div>}
      {readOnly && ['PROPOSED', 'APPROVED'].includes(a.status) && <div className="mb-4"><Notice>This is a read-only diagnostic. It changes nothing, so it needs no approval: carry it out and record what you found.</Notice></div>}
      {a.status === 'PROPOSED' && a.proposedByType === 'ai_agent' && <div className="mb-4"><Notice>This action was proposed by an AI investigation. Review the rationale and evidence before submitting it for approval.</Notice></div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card title="What will be done">
            <p className="text-sm whitespace-pre-wrap">{a.description}</p>
            {a.effectReasons && a.effectReasons.length > 0 && (
              <p className="mt-3 text-[13px] text-ink-2">
                <strong className="font-medium text-ink">{readOnly ? 'Classified as a read-only check' : 'Classified as a change to production'}:</strong> {a.effectReasons.join('; ')}. The classification is made from the type and wording of the action, not by whoever proposed it.
              </p>
            )}
            {a.parameters && Object.keys(a.parameters).length > 0 && (
              <>
                <h3 className="mt-4 mb-1 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Parameters</h3>
                <pre className="overflow-x-auto rounded-md bg-sunken p-3 font-mono text-[12px]">{JSON.stringify(a.parameters, null, 2)}</pre>
              </>
            )}
            {a.rationale && (
              <>
                <h3 className="mt-4 mb-1 text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Rationale</h3>
                <p className="text-sm whitespace-pre-wrap text-ink-2">{a.rationale}</p>
              </>
            )}
          </Card>

          <Card title="Approvals" description={readOnly ? 'None required for a read-only check' : `${a.approvalsGranted} of ${a.requiredApprovals} required · an approval counts only for the exact content it was given for`}>
            {a.approvals.length === 0 ? <p className="text-[13px] text-ink-2">{a.status === 'PROPOSED' ? 'Not yet submitted for approval.' : 'No decisions recorded yet.'}</p> : (
              <ul className="space-y-3">
                {a.approvals.map((ap) => (
                  <li key={ap.id} className="flex gap-3">
                    <Avatar name={ap.approver?.name ?? '?'} size={28} />
                    <div className="min-w-0">
                      <div className="text-sm"><span className="font-medium">{ap.approver?.name}</span> <span className={ap.decision === 'approved' ? 'text-good-ink' : 'text-critical-ink'}>{ap.decision}</span>{ap.decision === 'approved' && ap.counts === false && <span className="ml-1 rounded bg-warn-soft px-1 text-[11px] font-medium text-warn-ink">no longer counts: the action was changed afterwards</span>} <span className="text-[12px] text-ink-3">{timeAgo(ap.createdAt)}</span></div>
                      {ap.comment && <p className="mt-0.5 text-[13px] text-ink-2">{ap.comment}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {a.executionResult && (
            <Card title="Execution result">
              <Notice tone={a.executionResult.success ? 'good' : 'warn'}>{a.executionResult.summary}</Notice>
              <DefinitionList items={[['Outcome', a.executionResult.outcome === 'applied' ? 'Applied' : a.executionResult.outcome === 'not_applied' ? 'Not applied' : 'Unknown: may or may not have been applied'], ['Attempt', String(a.executionResult.attempt ?? a.attempts ?? 1)], ['Mode', a.executionResult.mode === 'diagnostic' ? 'Read-only diagnostic, recorded by a person' : a.executionResult.mode === 'manual' ? 'Carried out manually, attested in OPSILUME' : 'Dispatched to remediation webhook'], ['By', a.executedBy?.name ?? '—'], ['At', dateTime(a.executedAt)]]} />
              {a.executionResult.detail && <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-sunken p-3 font-mono text-[12px]">{JSON.stringify(a.executionResult.detail, null, 2)}</pre>}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Details">
            <DefinitionList
              items={[
                ['Proposed by', a.proposedByType === 'ai_agent' ? <span className="inline-flex items-center gap-1.5"><Bot className="size-3.5 text-accent" aria-hidden />OPSILUME AI</span> : a.proposedBy?.name ?? '—'],
                ['Requested by', a.requestedBy ? `${a.requestedBy.name}, ${timeAgo(a.requestedAt)}` : '—'],
                ['Service', a.service ? <Link href={`/services/${a.service.id}`} className="hover:underline">{a.service.name}</Link> : '—'],
                ['Created', dateTime(a.createdAt)],
              ]}
            />
          </Card>
          {a.incident && (
            <Card title="Incident">
              <Link href={`/incidents/${a.incident.id}`} className="block hover:underline"><Mono className="text-ink-2">INC-{a.incident.number}</Mono><div className="mt-0.5 text-sm font-medium">{a.incident.title}</div></Link>
              <div className="mt-2"><SeverityBadge severity={a.incident.severity} /></div>
            </Card>
          )}
          {a.investigation && (
            <Card title="Source investigation">
              <Link href={`/investigations/${a.investigation.id}`} className="text-sm font-medium text-accent hover:underline">{a.investigation.question}</Link>
              {a.investigation.summary && <p className="mt-2 line-clamp-6 text-[13px] text-ink-2">{a.investigation.summary}</p>}
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={dialog === 'approve' || dialog === 'reject'}
        onClose={() => setDialog(null)}
        title={dialog === 'approve' ? 'Approve this action' : 'Reject this action'}
        footer={<><Button onClick={() => setDialog(null)}>Back</Button><Button variant={dialog === 'reject' ? 'danger' : 'primary'} loading={busy === 'decide'} disabled={dialog === 'reject' && comment.trim().length < 3} onClick={() => void act(dialog === 'approve' ? 'approve' : 'reject', { ...(comment.trim() ? { comment } : {}), ...(dialog === 'approve' && a.currentHash ? { expectedHash: a.currentHash } : {}) }, 'decide')}>{dialog === 'approve' ? 'Approve' : 'Reject'}</Button></>}
      >
        <p className="mb-3 text-sm text-ink-2">{dialog === 'approve' ? `You are approving "${a.title}". Your name and time are recorded in the audit trail.` : 'The requester will be notified with your reason.'}</p>
        <FormError error={actionError} />
        <Field label={dialog === 'approve' ? 'Comment (optional)' : 'Reason'}>{(fid) => <Textarea id={fid} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      </Modal>

      <Modal
        open={dialog === 'execute'}
        onClose={() => setDialog(null)}
        title={readOnly ? 'Record this diagnostic as done' : manual ? 'Confirm manual execution' : 'Execute approved action'}
        footer={<><Button onClick={() => setDialog(null)}>Back</Button><Button variant="primary" loading={busy === 'execute'} onClick={() => void act('execute', manual || readOnly ? { confirmManual: true, ...(comment.trim() ? { notes: comment } : {}) } : {}, 'execute')}>{manual ? 'I have carried this out' : 'Dispatch now'}</Button></>}
      >
        <FormError error={actionError} />
        {manual || readOnly ? (
          <>
            <p className="mb-3 text-sm text-ink-2">OPSILUME is not connected to your infrastructure. Carry out <strong className="text-ink">{a.title}</strong> yourself, then confirm here. Your confirmation is recorded on the service history and in the audit trail.</p>
            <Field label="Notes (optional)" hint="For example the command you ran or the pipeline link.">{(fid) => <Textarea id={fid} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
          </>
        ) : (
          <p className="text-sm text-ink-2">This sends a signed request to your remediation webhook, which performs the change. The response is recorded here.</p>
        )}
      </Modal>
      <Modal
        open={dialog === 'retry'}
        onClose={() => setDialog(null)}
        title="Retry after an unknown outcome"
        footer={<><Button onClick={() => setDialog(null)}>Back</Button><Button variant="danger" loading={busy === 'retry'} onClick={() => void act('retry', { confirmNotApplied: true }, 'retry')}>I have checked: it was not applied</Button></>}
      >
        <FormError error={actionError} />
        <p className="text-sm text-ink-2">The last attempt may have changed the target system. Retrying sends the action again with the same idempotency key, but a receiver that does not honour the key would apply it twice. Confirm only after you have checked the target system and the change is <strong className="text-ink">not</strong> in place. Your confirmation is recorded in the audit trail.</p>
      </Modal>
    </>
  );
}
