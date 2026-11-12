'use client';

import { BookOpen, Plus, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/badges';
import { Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, Notice, PageHeader, Select, Spinner, Textarea } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { timeAgo, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Paged, ServiceRef } from '@/lib/types';

interface Doc { id: string; title: string; type: string; tags: string[]; indexStatus: string; indexError: string | null; embeddingModel: string | null; chunkCount: number; updatedAt: string; service: ServiceRef | null }
interface Hit { chunkId: string; documentId: string; title: string; type: string; heading: string | null; content: string; similarity: number | null; matchedBy: string[] }

function NewDoc({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const services = useApi<{ services: ServiceRef[] }>('/logs/facets');
  const [f, setF] = useState({ title: '', type: 'runbook', service: '', content: '' });
  return (
    <Modal open onClose={onClose} title="Add a document" wide footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="doc" loading={!!busy}>Add and index</Button></>}>
      <form id="doc" className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const d = await run(() => api.post<Doc>('/knowledge/documents', { ...f, service: f.service || null })); if (d) router.push(`/knowledge/${d.id}`); }}>
        <FormError error={error} />
        <Field label="Title">{(id) => <Input id={id} required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Runbook: Payment provider timeouts" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{(id) => <Select id={id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['runbook', 'postmortem', 'architecture', 'guide', 'policy', 'other'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>}</Field>
          <Field label="Service">{(id) => <Select id={id} value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}><option value="">General</option>{services.data?.services.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}</Select>}</Field>
        </div>
        <Field label="Content" hint="Markdown. Headings become sections, which are indexed and cited separately.">{(id) => <Textarea id={id} required rows={12} className="font-mono text-[13px]" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder={'# Title\n\n## Symptoms\n...\n\n## Mitigation\n...'} />}</Field>
      </form>
    </Modal>
  );
}

const IndexBadge = ({ doc }: { doc: Pick<Doc, 'indexStatus' | 'chunkCount'> }) =>
  doc.indexStatus === 'indexed' ? <Badge tone="good">Indexed · {doc.chunkCount} sections</Badge> : doc.indexStatus === 'failed' ? <Badge tone="warn">Keyword search only</Badge> : <Badge tone="info">Indexing…</Badge>;

export default function KnowledgePage() {
  const session = useSession();
  const canWrite = session.can('knowledge:write');
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<{ mode: string; note?: string; hits: Hit[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const { run, busy, error } = useAction();
  const docs = useApi<Paged<Doc>>(`/knowledge/documents${qs({ type, pageSize: 100 })}`, { refetchInterval: (q) => (q.state.data?.data.some((d) => ['pending', 'indexing'].includes(d.indexStatus)) ? 2000 : false) });

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return setResults(null);
    const r = await run(() => api.post<{ mode: string; note?: string; hits: Hit[] }>('/knowledge/search', { query, limit: 8 }), 'search');
    if (r) { setResults(r); setSubmitted(query); }
  }
  const failed = docs.data?.data.filter((d) => d.indexStatus === 'failed').length ?? 0;

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Runbooks, architecture notes, policies and postmortems. Investigations search this to find documented causes and mitigations, and cite the sections they use."
        actions={canWrite && <><Button loading={busy === 'reindex'} icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void run(() => api.post('/knowledge/reindex'), 'reindex')}>Reindex all</Button><Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Add document</Button></>}
      />
      {failed > 0 && <div className="mb-4"><Notice tone="warn">{failed} document{failed > 1 ? 's' : ''} could not be embedded because the AI service was unavailable. They are still found by keyword. Use Reindex all once the AI service is running.</Notice></div>}
      <Card className="mb-4">
        <form onSubmit={search} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" aria-hidden />
            <Input aria-label="Search the knowledge base" className="pl-8" placeholder="Describe a symptom, e.g. checkout cannot get a database connection" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setResults(null); }} />
          </div>
          <Button type="submit" variant="primary" loading={busy === 'search'}>Search</Button>
        </form>
        <FormError error={error} />
        {results && (
          <div className="mt-4">
            <p className="mb-2 text-[12px] text-ink-2">{results.hits.length} result{results.hits.length === 1 ? '' : 's'} for “{submitted}” · {results.mode === 'hybrid' ? 'semantic and keyword search combined' : 'keyword search only'}{results.note ? ` · ${results.note}` : ''}</p>
            {results.hits.length === 0 ? <p className="text-sm text-ink-2">Nothing relevant was found. Try the exact error message, or different wording.</p> : (
              <ul className="space-y-2">
                {results.hits.map((h) => (
                  <li key={h.chunkId} className="rounded-lg border border-line px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/knowledge/${h.documentId}`} className="text-sm font-semibold hover:underline">{h.heading ?? h.title}</Link>
                      <Badge>{titleCase(h.type)}</Badge>
                      <span className="ml-auto text-[12px] text-ink-3">{h.matchedBy.join(' + ')}{h.similarity !== null ? ` · similarity ${h.similarity.toFixed(2)}` : ''}</span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-[13px] whitespace-pre-line text-ink-2">{h.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card title="Documents" padded={false} actions={<Select aria-label="Type" className="h-8 w-40" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{['runbook', 'postmortem', 'architecture', 'guide', 'policy', 'other'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>}>
        {docs.error ? <div className="p-4"><ErrorState error={docs.error} /></div> : docs.isLoading || !docs.data ? <Spinner /> : docs.data.data.length === 0 ? (
          <EmptyState icon={<BookOpen className="size-5" aria-hidden />} title="No documents yet" description="Add the runbooks your on-call engineers actually use. Postmortems drafted from incidents are added here automatically." action={canWrite ? <Button size="sm" onClick={() => setAdding(true)}>Add a document</Button> : undefined} />
        ) : (
          <ul>
            {docs.data.data.map((d) => (
              <li key={d.id} className="border-b border-line last:border-0">
                <Link href={`/knowledge/${d.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-sunken/50">
                  <span className="min-w-0 flex-1 basis-72"><span className="block truncate text-sm font-medium">{d.title}</span><span className="text-[12px] text-ink-2">{titleCase(d.type)}{d.service ? ` · ${d.service.name}` : ''} · updated {timeAgo(d.updatedAt)}</span></span>
                  <IndexBadge doc={d} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <NewDoc onClose={() => setAdding(false)} />}
    </>
  );
}
