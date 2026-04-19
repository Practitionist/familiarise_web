/**
 * One-off backfill: create `OrgAdminProfile` rows for every existing
 * user who owns at least one organization, and link them via
 * `user.orgAdminProfileId`.
 *
 * Before this change, org creation was a post-signup flow that flipped
 * `user.role` to ORG_ADMIN but did not create any operator-side
 * profile. The refactor introduces `OrgAdminProfile` as the operator's
 * personal identity (mirroring StaffProfile / AdminProfile). New orgs
 * get it inside `POST /api/organizations`; this script covers the
 * historical rows.
 *
 * Idempotent — safe to re-run. The script uses `upsert` for the
 * profile row and a conditional `updateMany` for the User link.
 *
 * Run:
 *   pnpm tsx prisma/scripts/backfill-org-admin-profiles.ts
 *
 * Output format mirrors other prisma scripts: `created X, linked Y,
 * skipped Z` so the deployment checklist can grep for the numbers.
 */

import prisma from "../../lib/prisma";

const CHUNK_SIZE = 500;

async function main() {
  console.log("[backfill-org-admin-profiles] start");

  // Distinct users with at least one OWNER membership. Include PENDING
  // alongside ACTIVE because a freshly-seeded fixture org can sit in
  // PENDING briefly; we still want the OrgAdminProfile.
  const rows = await prisma.membership.findMany({
    where: {
      role: "OWNER",
      status: { in: ["ACTIVE", "PENDING"] },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  const userIds = rows.map((r) => r.userId);
  console.log(`[backfill-org-admin-profiles] candidates: ${userIds.length}`);

  let created = 0;
  let linked = 0;
  let skipped = 0;

  for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
    const chunk = userIds.slice(i, i + CHUNK_SIZE);

    await prisma.$transaction(
      async (tx) => {
        for (const userId of chunk) {
          const existing = await tx.orgAdminProfile.findUnique({
            where: { userId },
            select: { id: true },
          });

          let profileId: string;
          if (existing) {
            profileId = existing.id;
            skipped += 1;
          } else {
            const row = await tx.orgAdminProfile.create({
              data: { userId },
              select: { id: true },
            });
            profileId = row.id;
            created += 1;
          }

          const linkResult = await tx.user.updateMany({
            where: { id: userId, orgAdminProfileId: null },
            data: { orgAdminProfileId: profileId },
          });
          if (linkResult.count > 0) linked += 1;
        }
      },
      { timeout: 60_000 },
    );

    console.log(
      `[backfill-org-admin-profiles] progress: ${Math.min(i + CHUNK_SIZE, userIds.length)}/${userIds.length}`,
    );
  }

  console.log(
    `[backfill-org-admin-profiles] done — created ${created}, linked ${linked}, skipped ${skipped}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-org-admin-profiles] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
