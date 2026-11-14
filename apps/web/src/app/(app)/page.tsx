'use client';

import { CheckCircle2, Rocket, ShieldCheck, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { DeploymentStatusBadge, HealthDot, IncidentStatusBadge, InvestigationStatusBadge, RiskBadge, SeverityBadge } from '@/components/badges';
import { ERROR_SERIES, StackedBars } from '@/components/charts';
import { Card, EmptyState, ErrorState, LinkButton, Mono, Notice, PageHeader, Skeleton, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';
import { duration, percent, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Deployment, Ref, ServiceRef } from '@/lib/types';

interface Dashboard {
  activeIncidents: { id: string; key: string; title: string; severity: string; status: string; startedAt: string; services: ServiceRef[]; assignee: Ref | null }[];
  counts: { activeIncidents: number; incidentsThisWeek: number; firingAlerts: number; deploymentsLast24h: number; pendingApprovals: number; mttrMinutes30d: number | null };
  serviceHealth: Record<string, number>;
  recentDeployments: Deployment[];
  recentInvestigations: { id: string; question: string; status: string; confidence: number | null; createdAt: string; incident: { number: number } | null }[];
  pendingApprovals: { id: string; title: string; risk: string; requestedAt: string; requiredApprovals: number; approvalsRecorded: number }[];
  errorTrend: { timestamp: string; errors: number; warnings: number }[];
}

const HEALTH_ORDER = [
  ['DOWN', 'Down'],
  ['DEGRADED', 'Degraded'],
  ['HEALTHY', 'Healthy'],
  ['UNKNOWN', 'No data'],
] as const;

export default function OverviewPage() {
  const session = useSession();
  const { data, error, isLoading, refetch } = useApi<Dashboard>('/dashboard', { refetchInterval: 30_000 });

  if (error) return <ErrorState error={error} retry={() => void refetch()} />;
  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[86px]" />)}</div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  const { counts } = data;
  const totalServices = Object.values(data.serviceHealth).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${session.user.name.split(' ')[0]}`}
        description={counts.activeIncidents ? `${counts.activeIncidents} incident${counts.activeIncidents > 1 ? 's need' : ' needs'} attention across ${session.organization.name}.` : `No active incidents across ${session.organization.name}.`}
        actions={session.can('incident:write') && <LinkButton href="/incidents?new=1" variant="primary">Declare incident</LinkButton>}
      />

      {totalServices === 0 && (
        <div className="mb-4">
          <Notice>
            <strong>Nothing is connected yet.</strong> OPSILUME investigates with the logs, metrics, deployments and code changes of your services.{' '}
            <Link href="/integrations" className="font-medium underline underline-offset-2">See what can be connected and set it up</Link>.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Active incidents" value={counts.activeIncidents} tone={counts.activeIncidents ? 'critical' : undefined} hint={`${counts.incidentsThisWeek} opened in the last 7 days`} />
        <Stat label="Alerts firing" value={counts.firingAlerts} tone={counts.firingAlerts ? 'warn' : undefined} hint={<Link href="/monitoring" className="hover:underline">View monitoring</Link>} />
        <Stat label="Awaiting approval" value={counts.pendingApprovals} hint="Remediation actions" />
        <Stat label="Deployments, 24h" value={counts.deploymentsLast24h} hint={<Link href="/deployments" className="hover:underline">View history</Link>} />
        <Stat label="Median time to resolve" value={duration(counts.mttrMinutes30d)} hint="Incidents resolved in the last 30 days" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Active incidents" className="xl:col-span-2" padded={false} actions={<LinkButton href="/incidents" size="sm" variant="ghost">All incidents</LinkButton>}>
          {data.activeIncidents.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-5" aria-hidden />} title="All clear" description="There are no open incidents. New ones appear here when declared or when an alert rule opens one automatically." />
          ) : (
            <ul>
              {data.activeIncidents.map((i) => (
                <li key={i.id} className="border-b border-line last:border-0">
                  <Link href={`/incidents/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-sunken/60">
                    <SeverityBadge severity={i.severity} short />
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="truncate text-sm font-medium text-ink"><Mono className="mr-2 text-ink-2">{i.key}</Mono>{i.title}</div>
                      <div className="mt-0.5 truncate text-[12px] text-ink-2">{i.services.map((s) => s.name).join(', ') || 'No services linked'} · started {timeAgo(i.startedAt)} · {i.assignee ? i.assignee.name : 'unassigned'}</div>
                    </div>
                    <IncidentStatusBadge status={i.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Service health" description={`${totalServices} services`} actions={<LinkButton href="/services" size="sm" variant="ghost">Catalogue</LinkButton>}>
          {totalServices === 0 ? (
            <EmptyState title="No services yet" description="Add the services you run to track their health, deployments and incidents." action={<LinkButton href="/services" size="sm">Add a service</LinkButton>} />
          ) : (
            <>
              <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={HEALTH_ORDER.map(([k, l]) => `${data.serviceHealth[k] ?? 0} ${l}`).join(', ')}>
                {HEALTH_ORDER.map(([k]) => (data.serviceHealth[k] ? <div key={k} style={{ flex: data.serviceHealth[k] }} className={k === 'DOWN' ? 'bg-critical' : k === 'DEGRADED' ? 'bg-warn' : k === 'HEALTHY' ? 'bg-good' : 'bg-line-strong'} /> : null))}
              </div>
              <ul className="mt-4 space-y-2">
                {HEALTH_ORDER.map(([k, label]) => (
                  <li key={k} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-ink-2"><HealthDot health={k} />{label}</span>
                    <span className="tabular font-medium">{data.serviceHealth[k] ?? 0}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="Errors and warnings, last 24 hours" description="All services, from ingested logs" className="xl:col-span-2" actions={<LinkButton href="/logs" size="sm" variant="ghost">Log explorer</LinkButton>}>
          <StackedBars data={data.errorTrend} xKey="timestamp" series={ERROR_SERIES} time caption="Error and warning log counts per 30 minutes over the last 24 hours" emptyMessage="No warnings or errors were logged in the last 24 hours" height={210} />
        </Card>

        <Card title="Awaiting your team's approval" padded={false}>
          {data.pendingApprovals.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-5" aria-hidden />} title="Nothing waiting" description="Production-changing actions appear here until a person approves or rejects them." />
          ) : (
            <ul>
              {data.pendingApprovals.map((p) => (
                <li key={p.id} className="border-b border-line last:border-0">
                  <Link href={`/remediation/${p.id}`} className="block px-4 py-3 hover:bg-sunken/60">
                    <div className="text-sm font-medium text-ink">{p.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-2"><RiskBadge risk={p.risk} />{p.approvalsRecorded}/{p.requiredApprovals} approvals · {timeAgo(p.requestedAt)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent investigations" className="xl:col-span-2" padded={false} actions={<LinkButton href="/investigations" size="sm" variant="ghost">Workspace</LinkButton>}>
          {data.recentInvestigations.length === 0 ? (
            <EmptyState icon={<Sparkles className="size-5" aria-hidden />} title="No investigations yet" description="Ask OPSILUME to investigate an incident or any question about your systems. It gathers evidence and ranks hypotheses for you to verify." action={session.can('investigation:run') ? <LinkButton href="/investigations" size="sm">Start an investigation</LinkButton> : undefined} />
          ) : (
            <ul>
              {data.recentInvestigations.map((i) => (
                <li key={i.id} className="border-b border-line last:border-0">
                  <Link href={`/investigations/${i.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-sunken/60">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink">{i.question}</div>
                      <div className="mt-0.5 text-[12px] text-ink-2">{i.incident ? `INC-${i.incident.number} · ` : ''}{timeAgo(i.createdAt)}{i.confidence !== null ? ` · ${percent(i.confidence)} confidence` : ''}</div>
                    </div>
                    <InvestigationStatusBadge status={i.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest deployments" padded={false}>
          {data.recentDeployments.length === 0 ? (
            <EmptyState icon={<Rocket className="size-5" aria-hidden />} title="No deployments recorded" description="Send deployments from your CI/CD pipeline with an API key so investigations can correlate them with incidents." />
          ) : (
            <ul>
              {data.recentDeployments.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-0">
                  <div className="min-w-0">
                    <Link href={`/services/${d.service.id}`} className="block truncate text-sm font-medium hover:underline">{d.service.name}</Link>
                    <div className="text-[12px] text-ink-2"><Mono>{d.version}</Mono> · {timeAgo(d.startedAt)}</div>
                  </div>
                  <DeploymentStatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
