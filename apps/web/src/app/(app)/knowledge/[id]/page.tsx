'use client';

import { ExternalLink, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '@/components/badges';
import { Button, Card, DefinitionList, ErrorState, Field, FormError, Input, Modal, Mono, Notice, PageHeader, Spinner, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { dateTime, titleCase } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { ServiceRef } from '@/lib/types';

interface Doc { id: string; title: string; type: string; tags: string[]; content: string; sourceUrl: string | null; indexStatus: string; indexError: string | null; embeddingModel: string | null; chunkCount: number; incidentId: string | null; createdAt: string; updatedAt: string; service: ServiceRef | null; chunks: { id: string; index: number; heading: string | null; tokenEstimate: number }[] }

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const canWrite = session.can('knowledge:write');
  const { data: doc, error, isLoading } = useApi<Doc>(`/knowledge/documents/${id}`, { refetchInterval: (q) => (q.state.data && ['pending', 'indexing'].includes(q.state.data.indexStatus) ? 1500 : false) });
  const { run, busy, error: actionError } = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', content: '' });
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (error) return <ErrorState error={error} />;
  if (isLoading || !doc) return <Spinner label="Loading document" />;

  return (
    <>
      <PageHeader
        back={{ href: '/knowledge', label: 'Knowledge base' }}
        title={editing ? 'Editing document' : doc.title}
        description={!editing && <span className="mt-1 flex flex-wrap items-center gap-2"><Badge>{titleCase(doc.type)}</Badge>{doc.service && <Link href={`/services/${doc.service.id}`} className="hover:underline">{doc.service.name}</Link>}<span>Updated {dateTime(doc.updatedAt)}</span></span>}
        actions={canWrite && !editing && <><Button icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => { setDraft({ title: doc.title, content: doc.content }); setEditing(true); }}>Edit</Button><Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button></>}
      />
      <FormError error={actionError} />
      {doc.indexStatus === 'failed' && <div className="mb-4"><Notice tone="warn"><strong>Not embedded:</strong> {doc.indexError} This document is found by keyword search only until it is reindexed. {canWrite && <button type="button" className="font-medium underline" onClick={() => void run(() => api.post(`/knowledge/documents/${doc.id}/reindex`))}>Reindex now</button>}</Notice></div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          {editing ? (
            <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.patch(`/knowledge/documents/${doc.id}`, draft))) setEditing(false); }}>
              <Field label="Title">{(fid) => <Input id={fid} required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}</Field>
              <Field label="Content (Markdown)">{(fid) => <Textarea id={fid} required rows={24} className="font-mono text-[13px]" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />}</Field>
              <div className="flex gap-2"><Button type="submit" variant="primary" loading={!!busy}>Save and reindex</Button><Button onClick={() => setEditing(false)}>Cancel</Button></div>
            </form>
          ) : (
            <article className="prose-doc max-w-3xl text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown></article>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Search index">
            <DefinitionList
              items={[
                ['Status', doc.indexStatus === 'indexed' ? <Badge key="s" tone="good">Indexed</Badge> : doc.indexStatus === 'failed' ? <Badge key="s" tone="warn">Keyword only</Badge> : <Badge key="s" tone="info">Indexing…</Badge>],
                ['Sections', doc.chunkCount],
                ['Embeddings', doc.embeddingModel ? <Mono key="m">{doc.embeddingModel}</Mono> : '—'],
              ]}
            />
            {doc.embeddingModel?.startsWith('local:') && <p className="mt-3 text-[12px] text-ink-2">Built-in local embeddings match on wording, not meaning. Configure OpenAI or Ollama embeddings for semantic search, then reindex.</p>}
          </Card>
          <Card title="Sections" padded={false}>
            <ol className="max-h-80 overflow-y-auto py-1">{doc.chunks.map((c) => <li key={c.id} className="flex justify-between gap-2 px-4 py-1.5 text-[13px]"><span className="truncate">{c.heading?.split(' › ').at(-1) ?? 'Introduction'}</span><span className="tabular shrink-0 text-[12px] text-ink-3">~{c.tokenEstimate} tokens</span></li>)}</ol>
          </Card>
          {(doc.incidentId || doc.sourceUrl) && (
            <Card title="Links">
              {doc.incidentId && <Link href={`/incidents/${doc.incidentId}`} className="block text-sm text-accent hover:underline">Incident this postmortem covers</Link>}
              {doc.sourceUrl && <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-accent hover:underline">Original source<ExternalLink className="size-3" aria-hidden /></a>}
            </Card>
          )}
        </div>
      </div>
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this document?" footer={<><Button onClick={() => setConfirmDelete(false)}>Keep</Button><Button variant="danger" loading={!!busy} onClick={async () => { await run(() => api.delete(`/knowledge/documents/${doc.id}`)); router.replace('/knowledge'); }}>Delete document</Button></>}>
        <p className="text-sm text-ink-2">“{doc.title}” and its search index entries are removed permanently. Past investigations that cited it keep their summaries but the link will no longer open.</p>
      </Modal>
    </>
  );
}
