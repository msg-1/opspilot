import { z } from 'zod';
import { csvEnum, paginationQuery } from '../../lib/http';

/** Request validation for the investigation routes. */

export const createBody = z.object({
  question: z.string().trim().min(8, 'Describe what you want investigated').max(4000),
  incidentId: z.string().optional(),
  timeWindow: z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((w) => w.from < w.to, '"from" must be before "to"').optional(),
});

export const listQuery = paginationQuery.extend({ status: csvEnum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']), incidentId: z.string().optional() });
