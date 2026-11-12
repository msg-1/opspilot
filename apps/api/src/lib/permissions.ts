import type { Role } from '@prisma/client';

/**
 * Role-based access control. Roles are cumulative: each role has everything the
 * role below it has. API keys and AI tool tokens carry explicit scopes instead.
 */
const VIEWER = ['read'] as const;

const ENGINEER = [
  ...VIEWER,
  'incident:write',
  'service:write',
  'deployment:write',
  'log:write',
  'event:write',
  'metric:write',
  'monitoring:write',
  'knowledge:write',
  'github:sync',
  'investigation:run',
  'remediation:propose',
  // Engineers may approve LOW and MEDIUM risk actions; HIGH needs remediation:approve:high
  'remediation:approve',
  'remediation:execute',
] as const;

const ADMIN = [
  ...ENGINEER,
  'remediation:approve:high',
  'team:manage',
  'member:manage',
  'integration:manage',
  'apikey:manage',
  'audit:read',
  'settings:manage',
] as const;

const OWNER = [...ADMIN, 'org:manage'] as const;

export type Permission = (typeof OWNER)[number];

const BY_ROLE: Record<Role, ReadonlySet<string>> = {
  VIEWER: new Set(VIEWER),
  ENGINEER: new Set(ENGINEER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export const roleHas = (role: Role, permission: Permission) => BY_ROLE[role].has(permission);
export const permissionsFor = (role: Role): string[] => [...BY_ROLE[role]];

const RANK: Record<Role, number> = { VIEWER: 0, ENGINEER: 1, ADMIN: 2, OWNER: 3 };
export const roleRank = (role: Role) => RANK[role];

/** Scopes that can be granted to an API key. */
export const API_KEY_SCOPES = [
  'ingest:logs',
  'ingest:deployments',
  'ingest:events',
  'ingest:metrics',
  'tools:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
