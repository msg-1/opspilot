'use client';

import { CheckCircle2, Copy, Download, KeyRound, Plus, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/badges';
import { type AiStatus, EngineNotice } from '@/components/engine-notice';
import { Button, Card, DefinitionList, EmptyState, ErrorState, Field, FormError, Input, Modal, Mono, Notice, PageHeader, Pagination, Select, Spinner, Table, Tabs } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Paged } from '@/lib/types';

type Tab = 'organisation' | 'github' | 'keys' | 'audit' | 'system';

interface Settings { organization: { name: string; slug: string }; settings: { approvalsLowRisk: number; approvalsMediumRisk: number; approvalsHighRisk: number; allowSelfApproval: boolean; logRetentionDays: number; redactLogs: boolean; remediationWebhookUrl: string | null; remediationWebhookSecretSet: boolean } }

function Organisation() {
  const session = useSession();
  const can = session.can('settings:manage');
  const { data, error } = useApi<Settings>('/settings');
  const { run, busy, error: saveError } = useAction();
  const [f, setF] = useState<(Settings['settings'] & { name: string; secret: string }) | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data && !f) setF({ ...data.settings, name: data.organization.name, secret: '' }); }, [data, f]);
  if (error) return <ErrorState error={error} />;
  if (!f) return <Spinner />;
  // eslint-disable-next-line react/display-name -- render-prop factory, not a component
  const num = (k: 'approvalsLowRisk' | 'approvalsMediumRisk' | 'approvalsHighRisk' | 'logRetentionDays', min: number, max: number) => (id: string) => <Input id={id} type="number" min={min} max={max} disabled={!can} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />;
  return (
    <form
      className="max-w-3xl space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        const { secret, remediationWebhookSecretSet: _s, ...rest } = f;
        const ok = await run(() => api.patch('/settings', { ...rest, remediationWebhookUrl: rest.remediationWebhookUrl || null, ...(secret ? { remediationWebhookSecret: secret } : {}) }));
        if (ok) { setSaved(true); setF({ ...f, secret: '', remediationWebhookSecretSet: f.remediationWebhookSecretSet || !!secret }); }
      }}
    >
      {!can && <Notice>Only admins and owners can change these settings.</Notice>}
      <FormError error={saveError} />
      {saved && <Notice tone="good">Settings saved.</Notice>}
      <Card title="Organisation">
        <Field label="Name">{(id) => <Input id={id} required disabled={!can} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <p className="mt-3 text-[13px] text-ink-2">Identifier (slug): <Mono>{data?.organization.slug}</Mono>. It does not change with the name, and is what an operator uses to refer to this organisation.</p>
      </Card>
      <Card title="Remediation approvals" description="How many different people must approve an action before it can be executed.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Low risk">{num('approvalsLowRisk', 1, 5)}</Field>
          <Field label="Medium risk">{num('approvalsMediumRisk', 1, 5)}</Field>
          <Field label="High risk" hint="At least one must be an admin or owner.">{num('approvalsHighRisk', 1, 5)}</Field>
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" disabled={!can} checked={f.allowSelfApproval} onChange={(e) => setF({ ...f, allowSelfApproval: e.target.checked })} /><span>Allow people to approve actions they proposed or requested<span className="block text-[12px] text-ink-2">Off by default. Turning this on removes the separation of duties; the change is audited.</span></span></label>
      </Card>
      <Card title="Remediation execution" description="OPSILUME never changes your infrastructure directly.">
        <Field label="Remediation webhook URL" hint="When set, executing an approved action POSTs it here (for example to a CI/CD pipeline). When empty, operators carry out actions themselves and confirm in OPSILUME.">
          {(id) => <Input id={id} type="url" disabled={!can} placeholder="https://ci.example.com/hooks/opspilot" value={f.remediationWebhookUrl ?? ''} onChange={(e) => setF({ ...f, remediationWebhookUrl: e.target.value })} />}
        </Field>
        <Field className="mt-4" label="Signing secret" hint={`Requests carry an X-OpsPilot-Signature header (HMAC-SHA256 of the body). ${f.remediationWebhookSecretSet ? 'A secret is stored; enter a new one to replace it.' : 'No secret is stored yet.'}`}>
          {(id) => <Input id={id} type="password" autoComplete="off" minLength={16} disabled={!can} placeholder={f.remediationWebhookSecretSet ? '••••••••••••••••' : 'At least 16 characters'} value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />}
        </Field>
      </Card>
      <Card title="Logs">
        <Field label="Retention (days)" hint="Logs and metric samples older than this are deleted hourly.">{num('logRetentionDays', 1, 365)}</Field>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" disabled={!can} checked={f.redactLogs} onChange={(e) => setF({ ...f, redactLogs: e.target.checked })} /><span>Redact secrets before storing logs<span className="block text-[12px] text-ink-2">Masks passwords, tokens, API keys, JWTs and card-like numbers in messages and attributes at ingestion.</span></span></label>
      </Card>
      {can && <Button type="submit" variant="primary" loading={!!busy}>Save settings</Button>}
    </form>
  );
}

interface Integration { mode: string; tokenSource: string; accountLogin: string | null; webhookSecretSet: boolean; webhookPath: string; lastSyncAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null; repositoryCount: number }

function GitHub() {
  const session = useSession();
  const can = session.can('integration:manage');
  const { data, error } = useApi<Integration>('/github/integration');
  const { run, busy, error: saveError } = useAction();
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  if (error) return <ErrorState error={error} />;
  if (!data) return <Spinner />;
  return (
    <div className="max-w-3xl space-y-4">
      <FormError error={saveError} />
      <Card title="Connection">
        <DefinitionList
          items={[
            ['Mode', data.mode === 'token' ? <Badge key="m" tone="good" icon={<CheckCircle2 className="size-3" aria-hidden />}>Authenticated</Badge> : <Badge key="m" tone="warn">Unauthenticated (public repositories only)</Badge>],
            ['Token', data.tokenSource === 'organization' ? `Stored for this organisation, encrypted${data.accountLogin ? ` · account ${data.accountLogin}` : ''}` : data.tokenSource === 'environment' ? 'From the GITHUB_TOKEN environment variable' : 'None'],
            ['Repositories', data.repositoryCount],
            ['Last sync', data.lastSyncAt ? `${timeAgo(data.lastSyncAt)} · ${data.lastSyncStatus}` : 'Never'],
          ]}
        />
        {data.lastSyncError && <div className="mt-3"><Notice tone="warn">{data.lastSyncError}</Notice></div>}
      </Card>
      {can ? (
        <>
          <Card title="Personal access token" description="A fine-grained token with read-only access to Contents, Pull requests and Metadata is enough. It is validated against GitHub, then stored encrypted (AES-256-GCM) and never shown again.">
            <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.put('/github/integration', { token }), 'token')) setToken(''); }}>
              <Field label="Token" className="min-w-64 flex-1">{(id) => <Input id={id} type="password" autoComplete="off" required minLength={20} placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />}</Field>
              <Button type="submit" variant="primary" loading={busy === 'token'}>Validate and save</Button>
              {data.tokenSource === 'organization' && <Button loading={busy === 'remove'} onClick={() => { if (window.confirm('Remove the stored GitHub token?')) void run(() => api.put('/github/integration', { token: null }), 'remove'); }}>Remove token</Button>}
            </form>
          </Card>
          <Card title="Webhook" description="Optional. Receives pushes and pull request events as they happen instead of waiting for a sync.">
            <DefinitionList items={[['Payload URL', <Mono key="u">{`<public URL of your OPSILUME API>${data.webhookPath}`}</Mono>], ['Content type', <Mono key="c">application/json</Mono>], ['Events', 'Pushes, Pull requests'], ['Secret', data.webhookSecretSet ? 'Configured' : 'Not configured: webhooks are rejected until one is set']]} />
            <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.put('/github/integration', { webhookSecret: secret }), 'secret')) setSecret(''); }}>
              <Field label="Webhook secret" className="min-w-64 flex-1">{(id) => <Input id={id} type="password" autoComplete="off" required minLength={16} placeholder="Same value you enter in GitHub" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
              <Button type="submit" loading={busy === 'secret'}>Save secret</Button>
            </form>
            <p className="mt-3 text-[12px] text-ink-2">GitHub must be able to reach the API over the internet for webhooks to arrive; on a laptop that needs a tunnel. Syncing works without it.</p>
          </Card>
        </>
      ) : <Notice>Only admins and owners can change the GitHub integration.</Notice>}
    </div>
  );
}

interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
const SCOPE_HELP: Record<string, string> = { 'ingest:logs': 'Send logs', 'ingest:deployments': 'Record deployments', 'ingest:events': 'Record service events', 'ingest:metrics': 'Send metrics', 'tools:read': 'Read-only tool API (MCP server)' };

function ApiKeys() {
  const session = useSession();
  const { data, error } = useApi<{ data: ApiKey[]; availableScopes: string[] }>(session.can('apikey:manage') ? '/api-keys' : null);
  const { run, busy, error: saveError } = useAction();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['ingest:logs']);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!session.can('apikey:manage')) return <Notice>Only admins and owners can manage API keys.</Notice>;
  if (error) return <ErrorState error={error} />;
  if (!data) return <Spinner />;
  const close = () => { setCreating(false); setSecret(null); setName(''); setCopied(false); };
  return (
    <>
      <Card title="API keys" description="For machines: CI/CD pipelines, log shippers and the MCP server. Each key belongs to this organisation and is limited to its scopes." padded={false} actions={<Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setCreating(true)}>New key</Button>}>
        {data.data.length === 0 ? <EmptyState icon={<KeyRound className="size-5" aria-hidden />} title="No API keys" description="Create one to send logs, metrics and deployments, or to connect an MCP client." /> : (
          <Table head={<><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th>Created</th><th /></>}>
            {data.data.map((k) => (
              <tr key={k.id} className={k.revokedAt ? 'opacity-55' : undefined}>
                <td className="font-medium">{k.name}</td>
                <td><Mono>{k.prefix}…</Mono></td>
                <td><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div></td>
                <td className="text-ink-2">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'Never'}</td>
                <td className="text-ink-2">{timeAgo(k.createdAt)}</td>
                <td className="text-right">{k.revokedAt ? <Badge tone="critical">Revoked</Badge> : <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) void run(() => api.delete(`/api-keys/${k.id}`)); }}>Revoke</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={creating} onClose={close} title={secret ? 'Copy your new key' : 'New API key'} footer={secret ? <Button variant="primary" onClick={close}>I have copied it</Button> : <><Button onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="key" loading={!!busy} disabled={!scopes.length}>Create key</Button></>}>
        {secret ? (
          <div className="space-y-3">
            <Notice tone="warn">This is the only time the key is shown. OPSILUME stores only a hash of it.</Notice>
            <div className="flex gap-2"><Input readOnly aria-label="API key" value={secret} className="font-mono text-[12px]" onFocus={(e) => e.target.select()} /><Button icon={<Copy className="size-3.5" aria-hidden />} onClick={() => { void navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</Button></div>
            <p className="text-[12px] text-ink-2">Send it in the <Mono>x-api-key</Mono> header.</p>
          </div>
        ) : (
          <form id="key" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post<{ secret: string }>('/api-keys', { name, scopes })); if (r) setSecret(r.secret); }}>
            <FormError error={saveError} />
            <Field label="Name" hint="What will use it, e.g. GitHub Actions deploy job">{(id) => <Input id={id} required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <fieldset><legend className="mb-1 text-[13px] font-medium">Scopes</legend>
              {data.availableScopes.map((s) => <label key={s} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /><Mono>{s}</Mono><span className="text-ink-2">{SCOPE_HELP[s]}</span></label>)}
            </fieldset>
          </form>
        )}
      </Modal>
    </>
  );
}

interface AuditEntry { id: string; actorType: string; actorLabel: string | null; action: string; resourceType: string; resourceId: string | null; metadata: Record<string, unknown> | null; ip: string | null; createdAt: string }

function Audit() {
  const session = useSession();
  const [action, setAction] = useState('');
  const [actorType, setActorType] = useState('');
  const [page, setPage] = useState(1);
  const allowed = session.can('audit:read');
  const query = qs({ action, actorType, page, pageSize: 50 });
  const { data, error, isLoading } = useApi<Paged<AuditEntry>>(allowed ? `/audit-logs${query}` : null, { placeholderData: (p) => p });
  if (!allowed) return <Notice>Only admins and owners can read the audit log.</Notice>;
  return (
    <Card title="Audit log" description="An append-only record of who did what: sign-ins, changes, approvals, executions, and every tool the AI agent called." padded={false} actions={<a href={`/api/v1/audit-logs${qs({ action, actorType, format: 'csv' })}`} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[13px] font-medium hover:bg-sunken"><Download className="size-3.5" aria-hidden />CSV</a>}>
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
        <Select aria-label="Area" className="w-52" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
          <option value="">All activity</option>
          {[['auth', 'Sign-ins'], ['incident', 'Incidents'], ['investigation', 'Investigations'], ['ai_tool', 'AI tool calls'], ['remediation', 'Remediation and approvals'], ['member', 'Members'], ['apikey', 'API keys'], ['settings', 'Settings'], ['github', 'GitHub'], ['knowledge', 'Knowledge base'], ['service', 'Services'], ['deployment', 'Deployments'], ['alert', 'Alerts']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select aria-label="Actor" className="w-44" value={actorType} onChange={(e) => { setActorType(e.target.value); setPage(1); }}><option value="">Any actor</option><option value="user">People</option><option value="ai_agent">AI agent</option><option value="api_key">API keys</option><option value="system">System</option></Select>
      </div>
      {error ? <div className="p-4"><ErrorState error={error} /></div> : isLoading || !data ? <Spinner /> : data.data.length === 0 ? <EmptyState title="No matching audit entries" /> : (
        <>
          <Table head={<><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></>}>
            {data.data.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-ink-2" title={new Date(a.createdAt).toISOString()}>{dateTime(a.createdAt)}</td>
                <td className="whitespace-nowrap">{a.actorLabel ?? a.actorType}{a.actorType !== 'user' && <Badge className="ml-1.5" tone={a.actorType === 'ai_agent' ? 'info' : 'neutral'}>{a.actorType.replace('_', ' ')}</Badge>}</td>
                <td><Mono>{a.action}</Mono></td>
                <td className="text-ink-2">{a.resourceType.replace(/_/g, ' ')}</td>
                <td className="max-w-[26rem] truncate font-mono text-[11.5px] text-ink-2" title={a.metadata ? JSON.stringify(a.metadata) : undefined}>{a.metadata ? JSON.stringify(a.metadata) : ''}</td>
              </tr>
            ))}
          </Table>
          <div className="border-t border-line"><Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPage={setPage} /></div>
        </>
      )}
    </Card>
  );
}

interface SystemStatus { database: boolean; redis: boolean; queues: { name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }[]; ai: AiStatus & { embeddings?: { provider: string; model: string; dimensions: number } } }

function VerifyModel() {
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="mt-4 border-t border-line pt-4">
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.get<{ llm?: { verification?: { ok: boolean; detail: string } | null; available: boolean; detail: string } }>('/investigations/ai-status?verify=true');
            setResult(r.llm?.verification ?? { ok: false, detail: r.llm?.detail ?? 'No model provider is configured.' });
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Check API key and model
      </Button>
      <p className="mt-2 text-[12px] text-ink-2">Looks the configured model up with the provider. It confirms the key works without running inference, so it uses no credit.</p>
      <FormError error={error} />
      {result && <div className="mt-2"><Notice tone={result.ok ? 'good' : 'warn'}>{result.detail}</Notice></div>}
    </div>
  );
}

function System() {
  const { data, error } = useApi<SystemStatus>('/system/status', { refetchInterval: 10_000 });
  if (error) return <ErrorState error={error} />;
  if (!data) return <Spinner />;
  const Ok = ({ ok, label }: { ok: boolean; label: string }) => <span className="inline-flex items-center gap-1.5">{ok ? <CheckCircle2 className="size-4 text-good-ink" aria-hidden /> : <XCircle className="size-4 text-critical-ink" aria-hidden />}{label}</span>;
  return (
    <div className="max-w-3xl space-y-4">
      <Card title="Components">
        <DefinitionList items={[['Database', <Ok key="d" ok={data.database} label={data.database ? 'PostgreSQL reachable' : 'PostgreSQL unreachable'} />], ['Queue', <Ok key="r" ok={data.redis} label={data.redis ? 'Redis reachable' : 'Redis unreachable: background jobs are not running'} />], ['AI service', <Ok key="a" ok={data.ai.reachable} label={data.ai.reachable ? 'Reachable' : `Unreachable: ${data.ai.detail}`} />]]} />
      </Card>
      <Card title="AI configuration">
        <EngineNotice status={data.ai} />
        {data.ai.embeddings && <div className="mt-4"><DefinitionList items={[['Embeddings', <span key="e"><Mono>{data.ai.embeddings.provider}:{data.ai.embeddings.model}</Mono> · {data.ai.embeddings.dimensions} dimensions</span>]]} /></div>}
        <p className="mt-3 text-[12px] text-ink-2">The provider is configured in the <Mono>.env</Mono> file (<Mono>AI_PROVIDER</Mono>, <Mono>ANTHROPIC_API_KEY</Mono>, <Mono>ANTHROPIC_MODEL</Mono>, <Mono>AI_MAX_TOKENS</Mono> and the spending limits). Keys are never shown here. Restart the AI service after changing them, and reindex the knowledge base if the embedding provider changed.</p>
        <VerifyModel />
      </Card>
      <Card title="Background queues" padded={false}>
        {data.queues.length === 0 ? <p className="px-4 py-4 text-[13px] text-ink-2">Queue statistics are unavailable.</p> : (
          <Table head={<><th>Queue</th><th className="text-right">Waiting</th><th className="text-right">Active</th><th className="text-right">Delayed</th><th className="text-right">Completed</th><th className="text-right">Failed</th></>}>
            {data.queues.map((q) => <tr key={q.name}><td><Mono>{q.name}</Mono></td><td className="tabular text-right">{q.waiting}</td><td className="tabular text-right">{q.active}</td><td className="tabular text-right">{q.delayed}</td><td className="tabular text-right">{q.completed}</td><td className={`tabular text-right ${q.failed ? 'font-semibold text-critical-ink' : ''}`}>{q.failed}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('organisation');
  // Other pages link straight to a tab (/settings?tab=keys).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted && ['organisation', 'github', 'keys', 'audit', 'system'].includes(wanted)) setTab(wanted as Tab);
  }, []);
  return (
    <>
      <PageHeader title="Settings" description="Organisation policy, integrations, machine access, the audit trail and system status." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'organisation', label: 'Organisation' }, { id: 'github', label: 'GitHub' }, { id: 'keys', label: 'API keys' }, { id: 'audit', label: 'Audit log' }, { id: 'system', label: 'System' }]} />
      {tab === 'organisation' && <Organisation />}
      {tab === 'github' && <GitHub />}
      {tab === 'keys' && <ApiKeys />}
      {tab === 'audit' && <Audit />}
      {tab === 'system' && <System />}
    </>
  );
}
