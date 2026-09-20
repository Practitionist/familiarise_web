/**
 * Lazily create + link the operator profile for a user whose role is
 * ORG_WORKSPACE. Mirrors ensure-consultee-profile: idempotent on the
 * `userId @unique`, and the link is written only when it is still null.
 *
 * Callers: the role handoff (`setOnboardingRoleAction`), `POST /api/organizations`,
 * and — since #1699 made the profile required for the role — `requireOnboarded`,
 * which heals a completed legacy operator instead of bouncing them into a
 * wizard whose handoff refuses an onboarded user (review comment on #1699).
 */

import type { PrismaLike } from "@/lib/prisma";

export async function ensureOrgWorkspaceProfile(
  db: PrismaLike,
  userId: string,
): Promise<string> {
  const profile = await db.orgWorkspaceProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { id: true },
  });
  await db.user.updateMany({
    where: { id: userId, orgWorkspaceProfileId: null },
    data: { orgWorkspaceProfileId: profile.id },
  });
  return profile.id;
}
