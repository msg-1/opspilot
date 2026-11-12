import { z } from 'zod';
import { badRequest } from './errors';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export function paginate(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function paged<T>(data: T[], total: number, q: { page: number; pageSize: number }) {
  return { data, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } };
}

/** Accepts ISO timestamps or relative values such as "15m", "6h", "7d" (meaning "that long ago"). */
export const timeParam = z.string().transform((value, ctx) => {
  const rel = /^(\d+)([mhd])$/.exec(value);
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd'];
    return new Date(Date.now() - Number(rel[1]) * unit);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an ISO timestamp or a relative value like 6h' });
    return z.NEVER;
  }
  return date;
});

export const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));

export function assertRange(from: Date, to: Date, maxDays = 92) {
  if (from > to) throw badRequest('"from" must be before "to"');
  if (to.getTime() - from.getTime() > maxDays * 86_400_000) throw badRequest(`Time range may not exceed ${maxDays} days`);
}

/** Express 5 types route params as string | string[]; routes here only use plain segments. */
export const param = (value: string | string[] | undefined): string => {
  if (typeof value !== 'string' || !value) throw badRequest('Missing path parameter');
  return value;
};

/** Comma-separated list where every item must be one of the allowed values (400 otherwise). */
export const csvEnum = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).optional());

/** A link that will be rendered or fetched: http and https only (no javascript:, data:, file:). */
export const httpUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'Only http and https URLs are allowed');

/** One CSV cell. Values that a spreadsheet would run as a formula are neutralised. */
export const csvCell = (value: unknown): string => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
