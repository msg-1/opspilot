'use client';

import { AlertTriangle, CheckCircle2, Circle, CircleDashed, CircleDot, Copy, Link2, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/badges';
import { Button, Card, DefinitionList, ErrorState, FormError, LinkButton, Mono, Notice, PageHeader, Select, Skeleton } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Integration, IntegrationCheck, IntegrationOverview, Paged, Service } from '@/lib/types';

const I = 'size-3 shrink-0';
// The difference this page exists to show: saved (configured), answering (connected), and
// actually sending usable data (receiving data).
const STATUS: Record<Integration['status'], { label: string; tone: 'good' | 'info' | 'warn' | 'critical' | 'neutral'; icon: React.ReactNode }> = {
  not_configured: { label: 'Not set up', tone: 'neutral', icon: <CircleDashed className={I} aria-hidden /> },
  configured: { label: 'Set up, not yet verified', tone: 'info', icon: <Circle className={I} aria-hidden /> },
  connected: { label: 'Connected, no data yet', tone: 'info', icon: <CircleDot className={I} aria-hidden /> },
  delivering: { label: 'Receiving data', tone: 'good', icon: <CheckCircle2 className={I} aria-hidden /> },
  degraded: { label: 'Needs attention', tone: 'warn', icon: <AlertTriangle className={I} aria-hidden /> },
  unavailable: { label: 'Not working', tone: 'critical', icon: <XCircle className={I} aria-hidden /> },
};
// Sources where "connected" is the best there is: nothing flows through them continuously.
const CONNECTED_IS_FINE = new Set(['remediation_webhook', 'traces', 'analysis_engine']);
const KIND: Record<Integration['kind'], string> = { push: 'You send data to OPSILUME', pull: 'OPSILUME reads from the source', outbound: 'OPSILUME calls your endpoint', engine: 'Part of this installation' };
const TAB_LABEL = { keys: 'API keys', github: 'GitHub settings', organisation: 'Organisation settings' } as const;

function StatusBadge({ integration }: { integration: Integration }) {
  const s = STATUS[integration.status];
  const label = integration.status === 'connected' && CONNECTED_IS_FINE.has(integration.id) ? 'Connected' : s.label;
  return <Badge tone={integration.status === 'connected' && CONNECTED_IS_FINE.has(integration.id) ? 'good' : s.tone} icon={s.icon}>{label}</Badge>;
}

function Example({ integration }: { integration: Integration }) {
  const [copied, setCopied] = useState(false);
  if (!integration.setup.endpoint || !integration.setup.example) return null;
  const [method, path] = integration.setup.endpoint.split(' ');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  // The key is a placeholder on purpose: a real key is shown once, when it is created, and never again.
  const command = `curl -X ${method} ${origin}${path} \\\n  -H "x-api-key: $OPSILUME_API_KEY" \\\n  -H "content-type: application/json" \\\n  -d '${integration.setup.example}'`;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-ink-2">Example request</p>
        <Button size="sm" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-[12px] leading-5 text-ink-2">{command}</pre>
      <p className="mt-1 text-[12px] text-ink-3">Replace <Mono>checkout-service</Mono> with the slug of one of your services, and set <Mono>OPSILUME_API_KEY</Mono> to a key with the scope <Mono>{integration.setup.apiKeyScope}</Mono>.</p>
    </div>
  );
}

function IntegrationCard({ integration, onChanged }: { integration: Integration; onChanged: () => void }) {
  const session = useSession();
  const { run, busy, error } = useAction();
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const [open, setOpen] = useState(false);
  const canCheck = integration.setup.canCheck && session.can(integration.id === 'github' ? 'integration:manage' : 'settings:manage');
  const checkPath = integration.id === 'github' ? '/integrations/github/check' : '/integrations/remediation-webhook/check';
  const check = integration.lastCheck;
  return (
    <Card padded>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{integration.name}</h3>
          <p className="text-[12px] text-ink-3">{KIND[integration.kind]}{integration.scope === 'installation' ? ' · the same for every organisation' : ''}</p>
        </div>
        <span className="shrink-0"><StatusBadge integration={integration} /></span>
      </div>
      <p className="mt-2 text-[13px] text-ink-2">{integration.provides}</p>
      <p className="mt-2 text-[13px] font-medium text-ink" data-testid={`status-${integration.id}`}>{integration.statusDetail}</p>

      {integration.lastError && (
        <div className="mt-2"><Notice tone="warn"><strong>Last problem, {timeAgo(integration.lastError.at)}:</strong> {integration.lastError.message}</Notice></div>
      )}
      {check && (
        <div className="mt-2"><Notice tone={check.ok ? 'good' : 'warn'}><strong>{check.ok ? 'Check passed' : 'Check failed'}, {timeAgo(check.at)}:</strong> {check.detail}</Notice></div>
      )}
      {result && !check && <div className="mt-2"><Notice tone={result.ok ? 'good' : 'warn'}>{result.detail}</Notice></div>}
      <FormError error={error} />

      <div className="mt-3">
        <DefinitionList items={[...(integration.kind === 'push' || integration.id === 'github' ? [[integration.id === 'github' ? 'Last synchronised' : 'Last data received', integration.lastReceivedAt ? timeAgo(integration.lastReceivedAt) : 'Never'] as [string, React.ReactNode]] : []), ...integration.facts.map((f) => [f.label, f.value] as [string, React.ReactNode])]} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canCheck && (
          <Button size="sm" loading={busy === 'check'} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={async () => { const r = await run(() => api.post<IntegrationCheck>(checkPath), 'check'); if (r) { setResult(r); onChanged(); } }}>
            {integration.id === 'github' ? 'Check connection' : 'Send a test request'}
          </Button>
        )}
        {integration.setup.settingsTab && <LinkButton size="sm" href={`/settings?tab=${integration.setup.settingsTab}`}>{TAB_LABEL[integration.setup.settingsTab]}</LinkButton>}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'How to connect'}</Button>
      </div>
      {integration.id === 'remediation_webhook' && canCheck && <p className="mt-1 text-[12px] text-ink-3">The test request has the event <Mono>ping</Mono> and carries no action. A receiver must ignore events it does not know.</p>}

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div>
            <p className="text-[12px] font-medium text-ink-2">What it needs</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-ink-2">{integration.requires.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
          <Example integration={integration} />
        </div>
      )}
    </Card>
  );
}

function Unresolved({ data, onChanged }: { data: IntegrationOverview; onChanged: () => void }) {
  const session = useSession();
  const { run, busy, error } = useAction();
  const { data: services } = useApi<Paged<Service>>('/services?pageSize=100');
  const [target, setTarget] = useState<Record<string, string>>({});
  if (!data.unresolvedServices.length) return null;
  return (
    <Card title="Data that belongs to no service" description="These names arrived in incoming data and match no registered service. An investigation of a service only sees data that belongs to it.">
      <FormError error={error} />
      <ul className="divide-y divide-line">
        {data.unresolvedServices.map((u) => {
          const chosen = target[u.ref] ?? (u.registered ? u.ref : '');
          return (
            <li key={u.ref} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink"><Mono>{u.ref}</Mono></p>
                <p className="text-[12px] text-ink-3">
                  In {u.sources.join(', ')}{u.count !== null ? ` · ${u.count.toLocaleString('en-GB')} log lines stored without a service` : ''}{u.lastSeenAt ? ` · last seen ${timeAgo(u.lastSeenAt)}` : ''}
                  {!u.linkable && ' · this data was not stored; register the service and it will be accepted from then on'}
                </p>
              </div>
              {session.can('service:write') && (
                <div className="flex flex-wrap items-center gap-2">
                  {u.linkable && (
                    <>
                      <Select aria-label={`Service for ${u.ref}`} value={chosen} onChange={(e) => setTarget({ ...target, [u.ref]: e.target.value })} className="h-8 text-[13px]">
                        <option value="">Choose a service…</option>
                        {services?.data.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
                      </Select>
                      <Button size="sm" disabled={!chosen} loading={busy === u.ref} icon={<Link2 className="size-3.5" aria-hidden />} onClick={async () => { if (await run(() => api.post('/integrations/unresolved-services/link', { ref: u.ref, service: chosen }), u.ref)) onChanged(); }}>Give these lines to it</Button>
                    </>
                  )}
                  {!u.registered && <LinkButton size="sm" href="/services">Register a service</LinkButton>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] text-ink-3">To have new data matched automatically, register a service whose slug is exactly the name your systems send.</p>
    </Card>
  );
}

function Onboarding({ data }: { data: IntegrationOverview }) {
  const next = data.onboarding.steps.find((s) => !s.done);
  const done = data.onboarding.steps.filter((s) => s.done).length;
  if (data.onboarding.complete) return <Notice tone="good"><strong>Set-up is complete.</strong> Services are registered, data is arriving for them, and a first investigation has run. The sources below show whether that stays true.</Notice>;
  return (
    <Card title="Getting started" description={`${done} of ${data.onboarding.steps.length} steps done. Each step is ticked from what OPSILUME has actually received, not from what was entered.`}>
      <ol className="space-y-2.5">
        {data.onboarding.steps.map((step, i) => (
          <li key={step.id} className="flex items-start gap-2.5" data-testid={`step-${step.id}`} data-done={step.done}>
            {step.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" aria-label="Done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-ink-3" aria-label="Not done" />}
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">{i + 1}. {step.title}{step === next && <span className="ml-2 text-[12px] font-normal text-accent-strong">next</span>}</p>
              <p className="text-[12px] text-ink-2">{step.detail}{step === next && step.href !== '/integrations' && <> <Link href={step.href} className="font-medium text-accent-strong underline-offset-2 hover:underline">Open</Link></>}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function IntegrationsPage() {
  // While set-up is under way the page keeps itself current, so a first request shows up without a reload.
  const { data, error, isLoading, refetch } = useApi<IntegrationOverview>('/integrations', { refetchInterval: (q) => (q.state.data && !q.state.data.onboarding.complete ? 5000 : 30_000) });
  if (error) return <ErrorState error={error} retry={() => void refetch()} />;
  const own = data?.integrations.filter((i) => i.scope === 'organization') ?? [];
  const shared = data?.integrations.filter((i) => i.scope === 'installation') ?? [];
  return (
    <>
      <PageHeader title="Integrations" description="What OPSILUME can be connected to, what each source provides, and whether it is working. A source counts as working when data has arrived or a check was answered, not when a key was saved." />
      {isLoading || !data ? (
        <div className="space-y-3"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>
      ) : (
        <div className="space-y-5">
          <Onboarding data={data} />
          <Unresolved data={data} onChanged={() => void refetch()} />
          <section aria-labelledby="own-sources">
            <h2 id="own-sources" className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><PlugZap className="size-4" aria-hidden />Your organisation&apos;s sources</h2>
            <div className="grid gap-3 lg:grid-cols-2">{own.map((i) => <IntegrationCard key={i.id} integration={i} onChanged={() => void refetch()} />)}</div>
          </section>
          <section aria-labelledby="shared-sources">
            <h2 id="shared-sources" className="mb-1 text-sm font-semibold text-ink">Set for this installation</h2>
            <p className="mb-2 text-[13px] text-ink-2">These are configured by whoever operates this installation of OPSILUME and are the same for every organisation on it.</p>
            <div className="grid gap-3 lg:grid-cols-2">{shared.map((i) => <IntegrationCard key={i.id} integration={i} onChanged={() => void refetch()} />)}</div>
          </section>
        </div>
      )}
    </>
  );
}
