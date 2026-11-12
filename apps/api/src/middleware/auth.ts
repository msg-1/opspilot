import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { sha256 } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { type Permission, roleHas } from '../lib/permissions';
import { prisma } from '../lib/prisma';

export interface AuthContext {
  kind: 'user' | 'api_key' | 'tool_token';
  organizationId: string;
  /** Present for kind=user */
  userId?: string;
  role?: Role;
  /** Present for api_key / tool_token */
  scopes: string[];
  /** Human-readable actor label for audit entries */
  label: string;
  actorId?: string;
  investigationId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export const ACCESS_COOKIE = 'op_access';
export const REFRESH_COOKIE = 'op_refresh';
const ACCESS_TTL_SECONDS = 15 * 60;
const TOOL_TTL_SECONDS = 30 * 60;

interface AccessClaims {
  sub: string;
  org: string;
  typ: 'access';
}
interface ToolClaims {
  org: string;
  inv: string;
  typ: 'tool';
}

export const signAccessToken = (userId: string, organizationId: string) =>
  jwt.sign({ sub: userId, org: organizationId, typ: 'access' } satisfies AccessClaims, env.JWT_SECRET, {
    expiresIn: ACCESS_TTL_SECONDS,
  });

/** Short-lived, read-only, org-scoped token handed to the AI service for one investigation. */
export const signToolToken = (organizationId: string, investigationId: string) =>
  jwt.sign({ org: organizationId, inv: investigationId, typ: 'tool' } satisfies ToolClaims, env.JWT_SECRET, {
    expiresIn: TOOL_TTL_SECONDS,
  });

export const accessCookieMaxAgeMs = ACCESS_TTL_SECONDS * 1000;

/** Maps API-key / tool-token scopes onto the permission vocabulary used by routes. */
const SCOPE_GRANTS: Record<string, Permission[]> = {
  'tools:read': ['read'],
  'ingest:logs': ['log:write'],
  'ingest:deployments': ['deployment:write'],
  'ingest:events': ['event:write'],
  'ingest:metrics': ['metric:write'],
};

export function can(auth: AuthContext, permission: Permission): boolean {
  if (auth.kind === 'user') return !!auth.role && roleHas(auth.role, permission);
  return auth.scopes.some((s) => SCOPE_GRANTS[s]?.includes(permission));
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

async function fromUserToken(token: string): Promise<AuthContext | null> {
  let claims: AccessClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET) as AccessClaims;
  } catch {
    return null;
  }
  if (claims.typ !== 'access') return null;
  // Membership is re-read on every request so role changes and removals apply immediately.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: claims.sub, organizationId: claims.org } },
    include: { user: { select: { name: true, isActive: true } } },
  });
  if (!membership || !membership.user.isActive) return null;
  return {
    kind: 'user',
    organizationId: claims.org,
    userId: claims.sub,
    actorId: claims.sub,
    role: membership.role,
    scopes: [],
    label: membership.user.name,
  };
}

async function fromApiKey(key: string): Promise<AuthContext | null> {
  const record = await prisma.apiKey.findUnique({ where: { keyHash: sha256(key) } });
  if (!record || record.revokedAt) return null;
  // Best-effort usage stamp; never blocks the request.
  void prisma.apiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return {
    kind: 'api_key',
    organizationId: record.organizationId,
    scopes: record.scopes,
    label: `API key: ${record.name}`,
    actorId: record.id,
  };
}

function fromToolToken(token: string): AuthContext | null {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as ToolClaims;
    if (claims.typ !== 'tool') return null;
    return {
      kind: 'tool_token',
      organizationId: claims.org,
      scopes: ['tools:read'],
      label: 'AI investigation agent',
      investigationId: claims.inv,
    };
  } catch {
    return null;
  }
}

async function resolve(req: Request, allowToolToken: boolean): Promise<AuthContext | null> {
  const apiKey = req.header('x-api-key');
  if (apiKey) return fromApiKey(apiKey);
  const token = bearer(req) ?? (req.cookies?.[ACCESS_COOKIE] as string | undefined);
  if (!token) return null;
  if (token.startsWith('opk_')) return fromApiKey(token);
  const user = await fromUserToken(token);
  if (user) return user;
  return allowToolToken ? fromToolToken(token) : null;
}

/** Authenticates a user session (cookie or bearer) or an API key. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const auth = await resolve(req, false);
  if (!auth) throw unauthorized();
  req.auth = auth;
  next();
};

/** Same as authenticate, but also accepts the AI agent's tool token. Only used by /tools. */
export const authenticateTool: RequestHandler = async (req, _res, next) => {
  const auth = await resolve(req, true);
  if (!auth) throw unauthorized();
  req.auth = auth;
  next();
};

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    if (!can(req.auth, permission)) throw forbidden();
    next();
  };

/** Restricts a route to interactive users (no API keys / tool tokens). */
export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (req.auth.kind !== 'user') throw forbidden('This action requires a signed-in user');
  next();
};

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function userOf(req: Request): AuthContext & { userId: string; role: Role } {
  const auth = authOf(req);
  if (auth.kind !== 'user' || !auth.userId || !auth.role) throw forbidden('This action requires a signed-in user');
  return auth as AuthContext & { userId: string; role: Role };
}
