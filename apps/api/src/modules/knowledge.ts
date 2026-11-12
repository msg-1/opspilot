import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { aiService } from '../integrations/aiService';
import { audit } from '../lib/audit';
import { chunkMarkdown, embeddingText } from '../lib/chunking';
import { notFound } from '../lib/errors';
import { csv, httpUrl, paged, paginate, paginationQuery, param } from '../lib/http';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { authOf, requirePermission } from '../middleware/auth';
import { enqueue, registerProcessor } from '../queues';
import { findService } from './services';

export const DOC_TYPES = ['runbook', 'postmortem', 'architecture', 'guide', 'policy', 'other'] as const;

const docBody = z.object({
  title: z.string().trim().min(3).max(200),
  type: z.enum(DOC_TYPES).default('runbook'),
  content: z.string().min(1).max(400_000),
  sourceUrl: httpUrl.nullable().optional(),
  service: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

// ───────────────────────── Indexing (background job) ─────────────────────────

const vectorLiteral = (v: number[]) => `[${v.join(',')}]`;

export async function indexDocument(documentId: string) {
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) return;
  await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { indexStatus: 'indexing', indexError: null } });
  try {
    const chunks = chunkMarkdown(doc.title, doc.content);
    const vectors: number[][] = [];
    let model = '';
    for (let i = 0; i < chunks.length; i += 64) {
      const batch = chunks.slice(i, i + 64);
      const result = await aiService.embed(batch.map((c) => embeddingText(doc.title, c)), 'document');
      vectors.push(...result.vectors);
      model = `${result.provider}:${result.model}`;
    }
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { documentId: doc.id } });
      for (const [i, chunk] of chunks.entries()) {
        await tx.$executeRaw`
          INSERT INTO "KnowledgeChunk" ("id", "documentId", "organizationId", "index", "heading", "content", "tokenEstimate", "embedding")
          VALUES (${randomUUID()}, ${doc.id}, ${doc.organizationId}, ${chunk.index}, ${chunk.heading}, ${chunk.content}, ${chunk.tokenEstimate}, ${vectorLiteral(vectors[i]!)}::vector)`;
      }
      await tx.knowledgeDocument.update({ where: { id: doc.id }, data: { indexStatus: 'indexed', chunkCount: chunks.length, embeddingModel: model } });
    });
  } catch (err) {
    // Keep the text searchable by keyword even when embeddings are unavailable.
    const chunks = chunkMarkdown(doc.title, doc.content);
    await prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({ where: { documentId: doc.id } }),
      prisma.knowledgeChunk.createMany({
        data: chunks.map((c) => ({ documentId: doc.id, organizationId: doc.organizationId, index: c.index, heading: c.heading, content: c.content, tokenEstimate: c.tokenEstimate })),
      }),
      prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { indexStatus: 'failed', indexError: (err as Error).message.slice(0, 500), chunkCount: chunks.length, embeddingModel: null },
      }),
    ]);
    logger.warn({ err, documentId }, 'knowledge indexing failed; document is keyword-searchable only');
    throw err;
  }
}

registerProcessor('knowledge-index', ({ documentId }) => indexDocument(documentId));

// ───────────────────────── Retrieval ─────────────────────────

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  type: string;
  heading: string | null;
  content: string;
  serviceId: string | null;
  sourceUrl: string | null;
  /** Reciprocal-rank-fusion score across the vector and keyword rankings */
  score: number;
  /** Cosine similarity, when the chunk was found by vector search */
  similarity: number | null;
  matchedBy: ('vector' | 'keyword')[];
}

type Row = Omit<KnowledgeHit, 'score' | 'matchedBy' | 'similarity'> & { similarity?: number; rank?: number };

/**
 * Hybrid retrieval: pgvector cosine search + Postgres full-text search, merged with
 * reciprocal rank fusion. Falls back to keyword-only when the AI service is unavailable.
 */
export async function searchKnowledge(
  organizationId: string,
  query: string,
  opts: { limit?: number; types?: string[]; serviceId?: string } = {},
): Promise<{ mode: 'hybrid' | 'keyword'; hits: KnowledgeHit[]; note?: string }> {
  const limit = Math.min(opts.limit ?? 6, 20);
  const filters: Prisma.Sql[] = [Prisma.sql`c."organizationId" = ${organizationId}`];
  if (opts.types?.length) filters.push(Prisma.sql`d."type" = ANY(${opts.types})`);
  if (opts.serviceId) filters.push(Prisma.sql`(d."serviceId" = ${opts.serviceId} OR d."serviceId" IS NULL)`);
  const where = Prisma.join(filters, ' AND ');
  const cols = Prisma.sql`c."id" AS "chunkId", d."id" AS "documentId", d."title", d."type", c."heading", c."content", d."serviceId", d."sourceUrl"`;

  let vectorRows: Row[] = [];
  let note: string | undefined;
  try {
    const embedded = await aiService.embed([query], 'query');
    const model = `${embedded.provider}:${embedded.model}`;
    const literal = vectorLiteral(embedded.vectors[0]!);
    // Vectors from different embedding models are not comparable, so only matching documents take part.
    vectorRows = await prisma.$queryRaw<Row[]>`
      SELECT ${cols}, (1 - (c."embedding" <=> ${literal}::vector))::float8 AS similarity
      FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE ${where} AND c."embedding" IS NOT NULL AND d."embeddingModel" = ${model}
      ORDER BY c."embedding" <=> ${literal}::vector LIMIT 20`;
  } catch (err) {
    note = `Semantic search unavailable (${(err as Error).message}); showing keyword matches only.`;
  }

  const keywordRows = await prisma.$queryRaw<Row[]>`
    SELECT ${cols}, ts_rank_cd(to_tsvector('english', d."title" || ' ' || coalesce(c."heading", '') || ' ' || c."content"), q)::float8 AS rank
    FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d."id" = c."documentId",
         websearch_to_tsquery('english', ${query.split(/\s+/).filter(Boolean).join(' OR ')}) q
    WHERE ${where} AND to_tsvector('english', d."title" || ' ' || coalesce(c."heading", '') || ' ' || c."content") @@ q
    ORDER BY rank DESC LIMIT 20`;

  const K = 60;
  const merged = new Map<string, KnowledgeHit>();
  const add = (rows: Row[], by: 'vector' | 'keyword') =>
    rows.forEach((row, i) => {
      const { similarity, rank: _rank, ...rest } = row;
      const hit = merged.get(row.chunkId) ?? { ...rest, score: 0, similarity: null, matchedBy: [] };
      hit.score += 1 / (K + i + 1);
      hit.matchedBy.push(by);
      if (by === 'vector' && similarity !== undefined) hit.similarity = Math.round(similarity * 1000) / 1000;
      merged.set(row.chunkId, hit);
    });
  // Weak vector matches add noise. Take those above a floor, and always let a vector match
  // reinforce a chunk that the keyword ranking also found.
  const keywordIds = new Set(keywordRows.map((r) => r.chunkId));
  add(vectorRows.filter((r) => (r.similarity ?? 0) >= 0.15 || keywordIds.has(r.chunkId)), 'vector');
  add(keywordRows, 'keyword');
  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((h) => ({ ...h, score: Math.round(h.score * 10_000) / 10_000 }));
  return { mode: note ? 'keyword' : 'hybrid', hits, note };
}

// ───────────────────────── Routes ─────────────────────────

export async function createDocument(
  organizationId: string,
  input: z.infer<typeof docBody> & { incidentId?: string },
  createdById?: string,
) {
  const service = input.service ? await findService(organizationId, input.service) : null;
  const { service: _s, ...rest } = input;
  const doc = await prisma.knowledgeDocument.create({
    data: { ...rest, tags: input.tags?.map((t) => t.toLowerCase()) ?? [], organizationId, serviceId: service?.id ?? null, createdById },
  });
  await enqueue('knowledge-index', { documentId: doc.id });
  return doc;
}

export const knowledgeRouter = Router();

const summarySelect = {
  id: true,
  title: true,
  type: true,
  tags: true,
  sourceUrl: true,
  indexStatus: true,
  indexError: true,
  embeddingModel: true,
  chunkCount: true,
  incidentId: true,
  createdAt: true,
  updatedAt: true,
  service: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.KnowledgeDocumentSelect;

knowledgeRouter.get('/documents', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = paginationQuery.extend({ q: z.string().trim().optional(), type: csv, service: z.string().optional() }).parse(req.query);
  const service = q.service ? await findService(organizationId, q.service) : null;
  const where: Prisma.KnowledgeDocumentWhereInput = {
    organizationId,
    ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { tags: { has: q.q.toLowerCase() } }] } : {}),
    ...(q.type ? { type: { in: q.type } } : {}),
    ...(q.service ? { serviceId: service?.id ?? '__none__' } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.knowledgeDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, ...paginate(q), select: summarySelect }),
    prisma.knowledgeDocument.count({ where }),
  ]);
  res.json({ ...paged(rows, total, q), types: DOC_TYPES });
});

knowledgeRouter.post('/documents', requirePermission('knowledge:write'), async (req, res) => {
  const auth = authOf(req);
  const doc = await createDocument(auth.organizationId, docBody.parse(req.body), auth.userId);
  await audit(req, 'knowledge.create', 'knowledge_document', doc.id, { title: doc.title, type: doc.type });
  res.status(201).json(await prisma.knowledgeDocument.findUnique({ where: { id: doc.id }, select: { ...summarySelect, content: true } }));
});

knowledgeRouter.get('/documents/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const doc = await prisma.knowledgeDocument.findFirst({
    where: { id: param(req.params.id), organizationId },
    select: { ...summarySelect, content: true, chunks: { orderBy: { index: 'asc' }, select: { id: true, index: true, heading: true, tokenEstimate: true } } },
  });
  if (!doc) throw notFound('Document');
  res.json(doc);
});

knowledgeRouter.patch('/documents/:id', requirePermission('knowledge:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const existing = await prisma.knowledgeDocument.findFirst({ where: { id: param(req.params.id), organizationId } });
  if (!existing) throw notFound('Document');
  const { service: ref, ...body } = docBody.partial().parse(req.body);
  const service = ref ? await findService(organizationId, ref) : null;
  const needsReindex = (body.content !== undefined && body.content !== existing.content) || (body.title !== undefined && body.title !== existing.title);
  const doc = await prisma.knowledgeDocument.update({
    where: { id: existing.id },
    data: {
      ...body,
      ...(body.tags ? { tags: body.tags.map((t) => t.toLowerCase()) } : {}),
      ...(ref !== undefined ? { serviceId: service?.id ?? null } : {}),
      ...(needsReindex ? { indexStatus: 'pending' } : {}),
    },
  });
  if (needsReindex) await enqueue('knowledge-index', { documentId: doc.id });
  await audit(req, 'knowledge.update', 'knowledge_document', doc.id, { fields: Object.keys(body) });
  res.json(await prisma.knowledgeDocument.findUnique({ where: { id: doc.id }, select: { ...summarySelect, content: true } }));
});

knowledgeRouter.delete('/documents/:id', requirePermission('knowledge:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.knowledgeDocument.deleteMany({ where: { id: param(req.params.id), organizationId } });
  if (!result.count) throw notFound('Document');
  await audit(req, 'knowledge.delete', 'knowledge_document', param(req.params.id));
  res.status(204).end();
});

knowledgeRouter.post('/documents/:id/reindex', requirePermission('knowledge:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const doc = await prisma.knowledgeDocument.findFirst({ where: { id: param(req.params.id), organizationId }, select: { id: true } });
  if (!doc) throw notFound('Document');
  await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { indexStatus: 'pending', indexError: null } });
  await enqueue('knowledge-index', { documentId: doc.id });
  res.status(202).json({ id: doc.id, indexStatus: 'pending' });
});

/** Re-embeds every document, e.g. after switching embedding provider. */
knowledgeRouter.post('/reindex', requirePermission('knowledge:write'), async (req, res) => {
  const { organizationId } = authOf(req);
  const docs = await prisma.knowledgeDocument.findMany({ where: { organizationId }, select: { id: true } });
  await prisma.knowledgeDocument.updateMany({ where: { organizationId }, data: { indexStatus: 'pending', indexError: null } });
  for (const d of docs) await enqueue('knowledge-index', { documentId: d.id });
  await audit(req, 'knowledge.reindex_all', 'knowledge_document', null, { count: docs.length });
  res.status(202).json({ queued: docs.length });
});

knowledgeRouter.post('/search', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z
    .object({ query: z.string().trim().min(2).max(500), limit: z.number().int().min(1).max(20).default(8), types: z.array(z.enum(DOC_TYPES)).optional(), service: z.string().optional() })
    .parse(req.body);
  const service = body.service ? await findService(organizationId, body.service) : null;
  res.json(await searchKnowledge(organizationId, body.query, { limit: body.limit, types: body.types, serviceId: service?.id }));
});
