import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthContext } from '../middleware/auth';
import { logger } from './logger';
import { prisma } from './prisma';

export interface AuditInput {
  organizationId: string;
  actorType: 'user' | 'api_key' | 'ai_agent' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

/** Appends to the audit trail. Audit failures are logged but never fail the request. */
export async function writeAudit(entry: AuditInput, db: Pick<typeof prisma, 'auditLog'> = prisma) {
  try {
    await db.auditLog.create({ data: entry });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'failed to write audit log');
  }
}

const actorTypeOf = (auth: AuthContext): AuditInput['actorType'] =>
  auth.kind === 'user' ? 'user' : auth.kind === 'api_key' ? 'api_key' : 'ai_agent';

export function audit(
  req: Request,
  action: string,
  resourceType: string,
  resourceId?: string | null,
  metadata?: Prisma.InputJsonValue,
) {
  const auth = req.auth;
  if (!auth) return Promise.resolve();
  return writeAudit({
    organizationId: auth.organizationId,
    actorType: actorTypeOf(auth),
    actorId: auth.actorId,
    actorLabel: auth.label,
    action,
    resourceType,
    resourceId,
    metadata,
    ip: req.ip,
  });
}
