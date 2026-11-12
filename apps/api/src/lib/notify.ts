import type { Role } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';

interface NotifyInput {
  organizationId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

/** In-app notifications. Delivery failures never fail the calling operation. */
export async function notifyUsers(userIds: (string | null | undefined)[], input: NotifyInput) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (!ids.length) return;
  try {
    await prisma.notification.createMany({ data: ids.map((userId) => ({ ...input, userId })) });
  } catch (err) {
    logger.error({ err }, 'failed to create notifications');
  }
}

export async function notifyRoles(roles: Role[], input: NotifyInput, exceptUserId?: string | null) {
  const members = await prisma.membership.findMany({
    where: { organizationId: input.organizationId, role: { in: roles } },
    select: { userId: true },
  });
  await notifyUsers(
    members.map((m) => m.userId).filter((id) => id !== exceptUserId),
    input,
  );
}
