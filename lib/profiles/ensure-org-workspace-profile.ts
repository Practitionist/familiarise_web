/**
 * Lazily create + link the operator profile for a user whose role is
 * ORG_WORKSPACE. Mirrors ensure-consultee-profile: idempotent on the
 * `userId @unique`, and the link is written only when it is still null.
 *
 * Callers: `requireOnboarded`, which heals an onboarded ORG_WORKSPACE row that
 * lacks the link. `POST /api/organizations` upserts the same row in its tx.
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
