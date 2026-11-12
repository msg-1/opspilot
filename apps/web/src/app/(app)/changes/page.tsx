'use client';

import { GitBranch, GitPullRequest, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, SampleDataBadge } from '@/components/badges';
import { Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, Mono, Notice, PageHeader, Pagination, Select, Spinner, Table, Tabs } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { useAction, useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Paged, ServiceRef } from '@/lib/types';

interface Repo { id: string; fullName: string; url: string | null; isMock: boolean; lastSyncedAt: string | null; commitCount: number; pullRequestCount: number; service: ServiceRef | null }
interface RepoRef { id: string; fullName: string; isMock: boolean; service: ServiceRef | null }
interface Commit { id: string; sha: string; message: string; authorLogin: string | null; authorName: string | null; committedAt: string; url: string | null; additions: number | null; deletions: number | null; filesChanged: { filename: string }[] | null; repository: RepoRef }
interface Pull { id: string; number: number; title: string; state: string; authorLogin: string | null; url: string | null; mergedAt: string | null; openedAt: string; labels: string[]; repository: RepoRef }
interface Integration { mode: string; tokenSource: string; accountLogin: string | null; lastSyncAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null }

function AddRepo({ onClose, services }: { onClose: () => void; services: ServiceRef[] }) {
  const { run, busy, error } = useAction();
  const [f, setF] = useState({ fullName: '', service: '', sample: false });
  return (
    <Modal open onClose={onClose} title="Connect a repository" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="repo" loading={!!busy}>Connect and sync</Button></>}>
      <form id="repo" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/github/repositories', { fullName: f.fullName, service: f.service || null, sample: f.sample }))) onClose(); }}>
        <FormError error={error} />
        <Field label="Repository" hint="In the form owner/name">{(id) => <Input id={id} required pattern="[\w.\-]+/[\w.\-]+" placeholder="acme/checkout-service" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
        <Field label="Service it deploys" hint="Lets investigations tie code changes to this service.">{(id) => <Select id={id} value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}><option value="">Not linked</option>{services.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}</Select>}</Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={f.sample} onChange={(e) => setF({ ...f, sample: e.target.checked })} /><span>Use generated sample data<span className="block text-[12px] text-ink-2">Does not contact GitHub. Everything from this repository is labelled as sample data.</span></span></label>
      </form>
    </Modal>
  );
}

export default function ChangesPage() {
  const session = useSession();
  const [tab, setTab] = useState<'commits' | 'pulls' | 'repos'>('commits');
  const [search, setSearch] = useState('');
  const [repo, setRepo] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search);
  const { run, busy, error: actionError } = useAction();
  const integration = useApi<Integration>('/github/integration');
  const repos = useApi<{ data: Repo[] }>('/github/repositories', { refetchInterval: 20_000 });
  const facets = useApi<{ services: ServiceRef[] }>(adding ? '/logs/facets' : null);
  const commits = useApi<Paged<Commit>>(tab === 'commits' ? `/github/commits${qs({ q, repository: repo, page, pageSize: 25 })}` : null, { placeholderData: (p) => p });
  const pulls = useApi<Paged<Pull>>(tab === 'pulls' ? `/github/pull-requests${qs({ q, repository: repo, page, pageSize: 25 })}` : null, { placeholderData: (p) => p });
  const canManage = session.can('integration:manage');
  const i = integration.data;

  const filters = (
    <div className="mb-3 flex flex-wrap gap-2">
      <Input aria-label="Search" className="min-w-56 flex-1" placeholder={tab === 'commits' ? 'Search message, author or SHA' : 'Search title or author'} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      <Select aria-label="Repository" className="w-64" value={repo} onChange={(e) => { setRepo(e.target.value); setPage(1); }}><option value="">All repositories</option>{repos.data?.data.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Code changes"
        description="Commits and pull requests from connected GitHub repositories, linked to the services they deploy."
        actions={<>{session.can('github:sync') && !!repos.data?.data.length && <Button loading={busy === 'sync'} icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void run(() => api.post('/github/sync'), 'sync')}>Sync now</Button>}{canManage && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Connect repository</Button>}</>}
      />
      <FormError error={actionError} />
      {i && (
        <div className="mb-4 space-y-2">
          {i.mode === 'public' && <Notice tone="warn">No GitHub token is configured. Public repositories still sync, at GitHub&apos;s unauthenticated limit of 60 requests an hour. Add a token under Settings → GitHub for private repositories and higher limits.</Notice>}
          {i.lastSyncStatus === 'error' && <Notice tone="warn"><strong>The last sync had errors:</strong> {i.lastSyncError}</Notice>}
        </div>
      )}
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[{ id: 'commits', label: 'Commits' }, { id: 'pulls', label: 'Pull requests' }, { id: 'repos', label: 'Repositories', count: repos.data?.data.length }]} />

      {tab === 'commits' && (<>{filters}
        <Card padded={false}>
          {commits.error ? <div className="p-4"><ErrorState error={commits.error} /></div> : commits.isLoading || !commits.data ? <Spinner /> : commits.data.data.length === 0 ? <EmptyState icon={<GitBranch className="size-5" aria-hidden />} title="No commits" description="Connect a repository, then sync. New pushes also arrive through the GitHub webhook if you configure one." /> : (
            <>
              <ul>
                {commits.data.data.map((c) => (
                  <li key={c.id} className="border-b border-line px-4 py-2.5 last:border-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="font-mono text-[12.5px] text-accent hover:underline">{c.sha.slice(0, 7)}</a> : <Mono className="text-ink-2">{c.sha.slice(0, 7)}</Mono>}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.message.split('\n')[0]}</span>
                      {c.repository.isMock && <SampleDataBadge />}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-ink-2">
                      <span>{c.repository.fullName}</span>{c.repository.service && <span>→ {c.repository.service.name}</span>}
                      <span>{c.authorLogin ?? c.authorName}</span><span title={dateTime(c.committedAt)}>{timeAgo(c.committedAt)}</span>
                      {c.additions !== null && <span className="tabular"><span className="text-good-ink">+{c.additions}</span> <span className="text-critical-ink">−{c.deletions}</span></span>}
                      {c.filesChanged && c.filesChanged.length > 0 && <span className="truncate">{c.filesChanged.slice(0, 3).map((f) => f.filename).join(', ')}{c.filesChanged.length > 3 ? ` +${c.filesChanged.length - 3}` : ''}</span>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line"><Pagination page={commits.data.meta.page} totalPages={commits.data.meta.totalPages} total={commits.data.meta.total} onPage={setPage} /></div>
            </>
          )}
        </Card></>)}

      {tab === 'pulls' && (<>{filters}
        <Card padded={false}>
          {pulls.isLoading || !pulls.data ? <Spinner /> : pulls.data.data.length === 0 ? <EmptyState icon={<GitPullRequest className="size-5" aria-hidden />} title="No pull requests" /> : (
            <>
              <Table head={<><th>Pull request</th><th>Repository</th><th>State</th><th>Author</th><th>Merged</th></>}>
                {pulls.data.data.map((p) => (
                  <tr key={p.id}>
                    <td className="max-w-[28rem]"><span className="mr-2 font-mono text-[12.5px] text-ink-2">#{p.number}</span>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">{p.title}</a> : <span className="font-medium">{p.title}</span>}<div className="mt-0.5 flex flex-wrap gap-1">{p.labels.map((l) => <Badge key={l}>{l}</Badge>)}{p.repository.isMock && <SampleDataBadge />}</div></td>
                    <td className="text-ink-2">{p.repository.fullName}</td>
                    <td><Badge tone={p.state === 'merged' ? 'good' : p.state === 'open' ? 'info' : 'neutral'}>{p.state}</Badge></td>
                    <td className="text-ink-2">{p.authorLogin}</td>
                    <td className="whitespace-nowrap text-ink-2">{p.mergedAt ? timeAgo(p.mergedAt) : '—'}</td>
                  </tr>
                ))}
              </Table>
              <div className="border-t border-line"><Pagination page={pulls.data.meta.page} totalPages={pulls.data.meta.totalPages} total={pulls.data.meta.total} onPage={setPage} /></div>
            </>
          )}
        </Card></>)}

      {tab === 'repos' && (
        <Card padded={false}>
          {repos.isLoading || !repos.data ? <Spinner /> : repos.data.data.length === 0 ? <EmptyState icon={<GitBranch className="size-5" aria-hidden />} title="No repositories connected" description="Connect the repositories behind your services so investigations can read what each deployment changed." action={canManage ? <Button size="sm" onClick={() => setAdding(true)}>Connect a repository</Button> : undefined} /> : (
            <Table head={<><th>Repository</th><th>Service</th><th className="text-right">Commits</th><th className="text-right">Pull requests</th><th>Last synced</th><th /></>}>
              {repos.data.data.map((r) => (
                <tr key={r.id}>
                  <td><Mono className="font-semibold">{r.fullName}</Mono>{r.isMock && <span className="ml-2"><SampleDataBadge /></span>}</td>
                  <td>{r.service?.name ?? <span className="text-ink-3">Not linked</span>}</td>
                  <td className="tabular text-right">{r.commitCount}</td>
                  <td className="tabular text-right">{r.pullRequestCount}</td>
                  <td className="text-ink-2">{r.lastSyncedAt ? timeAgo(r.lastSyncedAt) : 'Never'}</td>
                  <td className="text-right">{canManage && <Button size="sm" variant="ghost" aria-label={`Disconnect ${r.fullName}`} onClick={() => { if (window.confirm(`Disconnect ${r.fullName}? Its synced commits and pull requests are removed from OpsPilot.`)) void run(() => api.delete(`/github/repositories/${r.id}`)); }}><Trash2 className="size-3.5" aria-hidden /></Button>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {adding && <AddRepo onClose={() => setAdding(false)} services={facets.data?.services ?? []} />}
    </>
  );
}
