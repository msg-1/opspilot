import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { encrypt, randomToken, sha256 } from '../lib/crypto';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { csvCell, httpUrl, paged, paginate, paginationQuery, param, timeParam } from '../lib/http';
import { assertSafeOutboundUrl } from '../lib/netguard';
import { API_KEY_SCOPES, roleRank } from '../lib/permissions';
import { prisma } from '../lib/prisma';
import { slugify } from '../lib/slug';
import { authOf, requirePermission, requireUser, userOf } from '../middleware/auth';

const roleEnum = z.enum(['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER']);

// ───────────────────────── Members & invitations ─────────────────────────

export const membersRouter = Router();

membersRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            title: true,
            isActive: true,
            lastLoginAt: true,
            teamMembers: { where: { team: { organizationId } }, select: { isLead: true, onCall: true, team: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.invitation.findMany({
      where: { organizationId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    }),
  ]);
  res.json({
    data: members.map((m) => ({
      id: m.id,
      role: m.role,
      joinedAt: m.createdAt,
      user: { ...m.user, teamMembers: undefined },
      teams: m.user.teamMembers.map((t) => ({ ...t.team, isLead: t.isLead, onCall: t.onCall })),
    })),
    invitations,
  });
});

membersRouter.post('/invitations', requirePermission('member:manage'), async (req, res) => {
  const auth = userOf(req);
  const body = z.object({ email: z.string().trim().toLowerCase().email(), role: roleEnum.default('ENGINEER') }).parse(req.body);
  if (roleRank(body.role) > roleRank(auth.role)) throw forbidden('You cannot invite someone with a higher role than your own');
  const existing = await prisma.membership.findFirst({ where: { organizationId: auth.organizationId, user: { email: body.email } } });
  if (existing) throw badRequest('That person is already a member');
  const token = randomToken(32);
  await prisma.invitation.deleteMany({ where: { organizationId: auth.organizationId, email: body.email, acceptedAt: null } });
  const invite = await prisma.invitation.create({
    data: {
      organizationId: auth.organizationId,
      email: body.email,
      role: body.role,
      tokenHash: sha256(token),
      invitedById: auth.userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  await audit(req, 'member.invite', 'invitation', invite.id, { email: body.email, role: body.role });
  // No email provider is configured in this local build, so the link is returned to the inviter to share.
  res.status(201).json({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, token, acceptPath: `/accept-invite?token=${token}` });
});

membersRouter.delete('/invitations/:id', requirePermission('member:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.invitation.deleteMany({ where: { id: param(req.params.id), organizationId } });
  if (!result.count) throw notFound('Invitation');
  await audit(req, 'member.invite_revoke', 'invitation', param(req.params.id));
  res.status(204).end();
});

async function assertNotLastOwner(organizationId: string, membershipId: string) {
  const owners = await prisma.membership.findMany({ where: { organizationId, role: 'OWNER' }, select: { id: true } });
  if (owners.length === 1 && owners[0]?.id === membershipId) throw badRequest('An organisation must keep at least one owner');
}

membersRouter.patch('/:id', requirePermission('member:manage'), async (req, res) => {
  const auth = userOf(req);
  const { role } = z.object({ role: roleEnum }).parse(req.body);
  const membership = await prisma.membership.findFirst({ where: { id: param(req.params.id), organizationId: auth.organizationId } });
  if (!membership) throw notFound('Member');
  if (roleRank(role) > roleRank(auth.role) || roleRank(membership.role) > roleRank(auth.role)) {
    throw forbidden('You cannot change a role above your own');
  }
  if (membership.role === 'OWNER' && role !== 'OWNER') await assertNotLastOwner(auth.organizationId, membership.id);
  const updated = await prisma.membership.update({ where: { id: membership.id }, data: { role } });
  await audit(req, 'member.role_change', 'membership', membership.id, { from: membership.role, to: role, userId: membership.userId });
  res.json({ id: updated.id, role: updated.role });
});

membersRouter.delete('/:id', requirePermission('member:manage'), async (req, res) => {
  const auth = userOf(req);
  const membership = await prisma.membership.findFirst({ where: { id: param(req.params.id), organizationId: auth.organizationId } });
  if (!membership) throw notFound('Member');
  if (roleRank(membership.role) > roleRank(auth.role)) throw forbidden('You cannot remove someone with a higher role');
  if (membership.role === 'OWNER') await assertNotLastOwner(auth.organizationId, membership.id);
  await prisma.$transaction([
    prisma.teamMember.deleteMany({ where: { userId: membership.userId, team: { organizationId: auth.organizationId } } }),
    prisma.refreshToken.updateMany({ where: { userId: membership.userId, organizationId: auth.organizationId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.membership.delete({ where: { id: membership.id } }),
  ]);
  await audit(req, 'member.remove', 'membership', membership.id, { userId: membership.userId });
  res.status(204).end();
});

// ───────────────────────── Teams ─────────────────────────

export const teamsRouter = Router();
const teamBody = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).nullable().optional() });

const teamInclude = {
  members: { include: { user: { select: { id: true, name: true, email: true, title: true } } } },
  services: { select: { id: true, name: true, slug: true, tier: true, health: true } },
} satisfies Prisma.TeamInclude;

teamsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const teams = await prisma.team.findMany({ where: { organizationId }, orderBy: { name: 'asc' }, include: teamInclude });
  res.json({ data: teams });
});

teamsRouter.post('/', requirePermission('team:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = teamBody.parse(req.body);
  const team = await prisma.team.create({ data: { ...body, organizationId, slug: slugify(body.name) }, include: teamInclude });
  await audit(req, 'team.create', 'team', team.id, { name: team.name });
  res.status(201).json(team);
});

teamsRouter.patch('/:id', requirePermission('team:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = teamBody.partial().parse(req.body);
  const existing = await prisma.team.findFirst({ where: { id: param(req.params.id), organizationId } });
  if (!existing) throw notFound('Team');
  const team = await prisma.team.update({
    where: { id: existing.id },
    data: { ...body, ...(body.name ? { slug: slugify(body.name) } : {}) },
    include: teamInclude,
  });
  await audit(req, 'team.update', 'team', team.id, body);
  res.json(team);
});

teamsRouter.delete('/:id', requirePermission('team:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.team.deleteMany({ where: { id: param(req.params.id), organizationId } });
  if (!result.count) throw notFound('Team');
  await audit(req, 'team.delete', 'team', param(req.params.id));
  res.status(204).end();
});

teamsRouter.put('/:id/members/:userId', requirePermission('team:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const body = z.object({ isLead: z.boolean().optional(), onCall: z.boolean().optional() }).parse(req.body ?? {});
  const teamId = param(req.params.id);
  const userId = param(req.params.userId);
  const [team, membership] = await Promise.all([
    prisma.team.findFirst({ where: { id: teamId, organizationId } }),
    prisma.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } }),
  ]);
  if (!team) throw notFound('Team');
  if (!membership) throw badRequest('That user is not a member of this organisation');
  const member = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId, userId } },
    create: { teamId, userId, ...body },
    update: body,
  });
  await audit(req, 'team.member_set', 'team', teamId, { userId, ...body });
  res.json(member);
});

teamsRouter.delete('/:id/members/:userId', requirePermission('team:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.teamMember.deleteMany({
    where: { teamId: param(req.params.id), userId: param(req.params.userId), team: { organizationId } },
  });
  if (!result.count) throw notFound('Team member');
  await audit(req, 'team.member_remove', 'team', param(req.params.id), { userId: param(req.params.userId) });
  res.status(204).end();
});

// ───────────────────────── Organisation settings ─────────────────────────

export const settingsRouter = Router();

const settingsBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  approvalsLowRisk: z.number().int().min(1).max(5).optional(),
  approvalsMediumRisk: z.number().int().min(1).max(5).optional(),
  approvalsHighRisk: z.number().int().min(1).max(5).optional(),
  allowSelfApproval: z.boolean().optional(),
  logRetentionDays: z.number().int().min(1).max(365).optional(),
  redactLogs: z.boolean().optional(),
  remediationWebhookUrl: httpUrl.nullable().optional(),
  remediationWebhookSecret: z.string().min(16).max(200).nullable().optional(),
});

export async function getSettings(organizationId: string) {
  return prisma.organizationSettings.upsert({ where: { organizationId }, create: { organizationId }, update: {} });
}

async function settingsView(organizationId: string) {
  const [org, s] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true, name: true, slug: true, createdAt: true } }),
    getSettings(organizationId),
  ]);
  const { remediationWebhookSecretEncrypted, organizationId: _omit, ...rest } = s;
  return { organization: org, settings: { ...rest, remediationWebhookSecretSet: !!remediationWebhookSecretEncrypted } };
}

settingsRouter.get('/', requirePermission('read'), async (req, res) => {
  res.json(await settingsView(authOf(req).organizationId));
});

settingsRouter.patch('/', requirePermission('settings:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const { name, remediationWebhookSecret, ...rest } = settingsBody.parse(req.body);
  if (rest.remediationWebhookUrl) await assertSafeOutboundUrl(rest.remediationWebhookUrl);
  await getSettings(organizationId);
  await prisma.$transaction([
    prisma.organizationSettings.update({
      where: { organizationId },
      data: {
        ...rest,
        ...(remediationWebhookSecret !== undefined
          ? { remediationWebhookSecretEncrypted: remediationWebhookSecret ? encrypt(remediationWebhookSecret) : null }
          : {}),
      },
    }),
    ...(name ? [prisma.organization.update({ where: { id: organizationId }, data: { name } })] : []),
  ]);
  await audit(req, 'settings.update', 'organization', organizationId, {
    ...rest,
    ...(name ? { name } : {}),
    ...(remediationWebhookSecret !== undefined ? { remediationWebhookSecret: '[changed]' } : {}),
  });
  res.json(await settingsView(organizationId));
});

// ───────────────────────── API keys ─────────────────────────

export const apiKeysRouter = Router();

apiKeysRouter.get('/', requirePermission('apikey:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const keys = await prisma.apiKey.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
  });
  res.json({ data: keys, availableScopes: API_KEY_SCOPES });
});

apiKeysRouter.post('/', requirePermission('apikey:manage'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const body = z
    .object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) })
    .parse(req.body);
  const secret = `opk_${randomToken(30)}`;
  const key = await prisma.apiKey.create({
    data: {
      organizationId: auth.organizationId,
      name: body.name,
      scopes: [...new Set(body.scopes)],
      prefix: secret.slice(0, 10),
      keyHash: sha256(secret),
      createdById: auth.userId,
    },
  });
  await audit(req, 'apikey.create', 'api_key', key.id, { name: key.name, scopes: key.scopes });
  // The secret is shown exactly once; only its SHA-256 hash is stored.
  res.status(201).json({ id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, createdAt: key.createdAt, secret });
});

apiKeysRouter.delete('/:id', requirePermission('apikey:manage'), async (req, res) => {
  const { organizationId } = authOf(req);
  const result = await prisma.apiKey.updateMany({
    where: { id: param(req.params.id), organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!result.count) throw notFound('API key');
  await audit(req, 'apikey.revoke', 'api_key', param(req.params.id));
  res.status(204).end();
});

// ───────────────────────── Audit trail ─────────────────────────

export const auditRouter = Router();

const auditQuery = paginationQuery.extend({
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  actorId: z.string().optional(),
  actorType: z.string().optional(),
  from: timeParam.optional(),
  to: timeParam.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

auditRouter.get('/', requirePermission('audit:read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = auditQuery.parse(req.query);
  const where: Prisma.AuditLogWhereInput = {
    organizationId,
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.resourceType ? { resourceType: q.resourceType } : {}),
    ...(q.resourceId ? { resourceId: q.resourceId } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.actorType ? { actorType: q.actorType } : {}),
    ...(q.from || q.to ? { createdAt: { gte: q.from, lte: q.to } } : {}),
  };
  if (q.format === 'csv') {
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000 });
    const lines = [
      'timestamp,actor_type,actor,action,resource_type,resource_id,ip,metadata',
      ...rows.map((r) =>
        [r.createdAt.toISOString(), r.actorType, r.actorLabel, r.action, r.resourceType, r.resourceId, r.ip, r.metadata ? JSON.stringify(r.metadata) : '']
          .map(csvCell)
          .join(','),
      ),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="opspilot-audit-log.csv"');
    res.send(lines.join('\n'));
    return;
  }
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

// ───────────────────────── Notifications ─────────────────────────

export const notificationsRouter = Router();

notificationsRouter.get('/', requireUser, async (req, res) => {
  const auth = userOf(req);
  const where = { userId: auth.userId, organizationId: auth.organizationId };
  const [data, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 40 }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  res.json({ data, unread });
});

notificationsRouter.post('/read', requireUser, async (req, res) => {
  const auth = userOf(req);
  const { ids } = z.object({ ids: z.array(z.string()).max(200).optional() }).parse(req.body ?? {});
  await prisma.notification.updateMany({
    where: { userId: auth.userId, organizationId: auth.organizationId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  res.status(204).end();
});
