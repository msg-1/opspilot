import clsx from 'clsx';
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, CircleDot, HelpCircle, Info, Loader2, MinusCircle, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { titleCase } from '@/lib/format';

type Tone = 'critical' | 'serious' | 'warn' | 'good' | 'info' | 'neutral';

const TONE: Record<Tone, string> = {
  critical: 'bg-critical-soft text-critical-ink border-critical/25',
  serious: 'bg-serious-soft text-serious-ink border-serious/30',
  warn: 'bg-warn-soft text-warn-ink border-warn/40',
  good: 'bg-good-soft text-good-ink border-good/25',
  info: 'bg-accent-soft text-accent-strong border-accent/20',
  neutral: 'bg-sunken text-ink-2 border-line',
};

/** Status is never conveyed by colour alone: every badge has a label and, where it marks state, an icon. */
export function Badge({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] leading-4 font-medium whitespace-nowrap', TONE[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

const I = 'size-3 shrink-0';

const SEVERITY: Record<string, { tone: Tone; label: string }> = {
  SEV1: { tone: 'critical', label: 'SEV1 · Critical' },
  SEV2: { tone: 'serious', label: 'SEV2 · Major' },
  SEV3: { tone: 'warn', label: 'SEV3 · Minor' },
  SEV4: { tone: 'neutral', label: 'SEV4 · Low' },
};

export function SeverityBadge({ severity, short }: { severity: string; short?: boolean }) {
  const s = SEVERITY[severity] ?? { tone: 'neutral' as Tone, label: severity };
  return <Badge tone={s.tone} icon={severity === 'SEV1' ? <AlertOctagon className={I} aria-hidden /> : severity === 'SEV2' ? <AlertTriangle className={I} aria-hidden /> : undefined}>{short ? severity : s.label}</Badge>;
}

const INCIDENT_STATUS: Record<string, Tone> = { OPEN: 'critical', INVESTIGATING: 'serious', IDENTIFIED: 'warn', MITIGATED: 'info', RESOLVED: 'good', CLOSED: 'neutral' };

export function IncidentStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={INCIDENT_STATUS[status] ?? 'neutral'} icon={status === 'RESOLVED' || status === 'CLOSED' ? <CheckCircle2 className={I} aria-hidden /> : <CircleDot className={I} aria-hidden />}>
      {titleCase(status)}
    </Badge>
  );
}

const HEALTH: Record<string, { tone: Tone; icon: ReactNode; label: string }> = {
  HEALTHY: { tone: 'good', icon: <CheckCircle2 className={I} aria-hidden />, label: 'Healthy' },
  DEGRADED: { tone: 'warn', icon: <AlertTriangle className={I} aria-hidden />, label: 'Degraded' },
  DOWN: { tone: 'critical', icon: <XCircle className={I} aria-hidden />, label: 'Down' },
  UNKNOWN: { tone: 'neutral', icon: <HelpCircle className={I} aria-hidden />, label: 'No data' },
};

export function HealthBadge({ health }: { health: string }) {
  const h = HEALTH[health] ?? HEALTH.UNKNOWN!;
  return <Badge tone={h.tone} icon={h.icon}>{h.label}</Badge>;
}

export function HealthDot({ health }: { health: string }) {
  const color = health === 'HEALTHY' ? 'bg-good' : health === 'DEGRADED' ? 'bg-warn' : health === 'DOWN' ? 'bg-critical' : 'bg-line-strong';
  return <span role="img" aria-label={HEALTH[health]?.label ?? 'No data'} className={clsx('inline-block size-2 shrink-0 rounded-full', color)} />;
}

const DEPLOY: Record<string, { tone: Tone; icon: ReactNode }> = {
  SUCCEEDED: { tone: 'good', icon: <CheckCircle2 className={I} aria-hidden /> },
  FAILED: { tone: 'critical', icon: <XCircle className={I} aria-hidden /> },
  ROLLED_BACK: { tone: 'serious', icon: <MinusCircle className={I} aria-hidden /> },
  IN_PROGRESS: { tone: 'info', icon: <Loader2 className={clsx(I, 'animate-spin')} aria-hidden /> },
  PENDING: { tone: 'neutral', icon: <CircleDashed className={I} aria-hidden /> },
};

export function DeploymentStatusBadge({ status }: { status: string }) {
  const d = DEPLOY[status] ?? DEPLOY.PENDING!;
  return <Badge tone={d.tone} icon={d.icon}>{titleCase(status)}</Badge>;
}

const REMEDIATION: Record<string, Tone> = { PROPOSED: 'neutral', PENDING_APPROVAL: 'warn', APPROVED: 'info', REJECTED: 'critical', EXECUTING: 'info', EXECUTED: 'good', FAILED: 'critical', CANCELLED: 'neutral' };

export function RemediationStatusBadge({ status }: { status: string }) {
  const label = status === 'PENDING_APPROVAL' ? 'Awaiting approval' : titleCase(status);
  return (
    <Badge
      tone={REMEDIATION[status] ?? 'neutral'}
      icon={status === 'EXECUTED' ? <CheckCircle2 className={I} aria-hidden /> : status === 'REJECTED' || status === 'FAILED' ? <XCircle className={I} aria-hidden /> : status === 'EXECUTING' ? <Loader2 className={clsx(I, 'animate-spin')} aria-hidden /> : undefined}
    >
      {label}
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: string }) {
  return <Badge tone={risk === 'HIGH' ? 'critical' : risk === 'MEDIUM' ? 'warn' : 'neutral'}>{titleCase(risk)} risk</Badge>;
}

const INVESTIGATION: Record<string, { tone: Tone; icon: ReactNode; label: string }> = {
  QUEUED: { tone: 'neutral', icon: <CircleDashed className={I} aria-hidden />, label: 'Queued' },
  RUNNING: { tone: 'info', icon: <Loader2 className={clsx(I, 'animate-spin')} aria-hidden />, label: 'Investigating' },
  COMPLETED: { tone: 'good', icon: <CheckCircle2 className={I} aria-hidden />, label: 'Completed' },
  FAILED: { tone: 'critical', icon: <XCircle className={I} aria-hidden />, label: 'Failed' },
  CANCELLED: { tone: 'neutral', icon: <MinusCircle className={I} aria-hidden />, label: 'Cancelled' },
};

export function InvestigationStatusBadge({ status }: { status: string }) {
  const s = INVESTIGATION[status] ?? INVESTIGATION.QUEUED!;
  return <Badge tone={s.tone} icon={s.icon}>{s.label}</Badge>;
}

const LEVEL: Record<string, string> = {
  FATAL: 'bg-critical text-white',
  ERROR: 'bg-critical-soft text-critical-ink',
  WARN: 'bg-warn-soft text-warn-ink',
  INFO: 'bg-accent-soft text-accent-strong',
  DEBUG: 'bg-sunken text-ink-2',
  TRACE: 'bg-sunken text-ink-3',
};

export function LevelTag({ level }: { level: string }) {
  return <span className={clsx('inline-block w-[46px] rounded px-1 py-px text-center font-mono text-[11px] font-semibold', LEVEL[level] ?? LEVEL.DEBUG)}>{level}</span>;
}

export function ConfidenceMeter({ value, status }: { value: number; status?: string }) {
  const pct = Math.round(value * 100);
  const word = pct >= 70 ? 'High' : pct >= 40 ? 'Moderate' : 'Low';
  return (
    <div className="flex items-center gap-2" title={`${pct}% confidence`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Confidence">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular text-[13px] font-medium text-ink">{pct}%</span>
      <span className="text-[12px] text-ink-2">{status ? titleCase(status) : word}</span>
    </div>
  );
}

export const TierBadge = ({ tier }: { tier: string }) => <Badge tone={tier === 'TIER1' ? 'info' : 'neutral'}>{tier.replace('TIER', 'Tier ')}</Badge>;

export const SampleDataBadge = () => (
  <Badge tone="warn" icon={<Info className={I} aria-hidden />}>
    Sample data
  </Badge>
);
