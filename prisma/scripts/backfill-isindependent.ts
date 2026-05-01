/**
 * Backfill `ConsultantProfile.isIndependent` for the A4 / #674 work.
 *
 * Walks every ConsultantProfile and recomputes `isIndependent` from the
 * current Membership state:
 *
 *   isIndependent = true  iff the consultant has ZERO active EXPERT
 *                          memberships at HOST-capable orgs
 *                          (organization.canHost = true).
 *
 *   isIndependent = false iff the consultant is hosted by at least one
 *                          HOST org via an active EXPERT membership.
 *
 * Idempotent: safe to run multiple times. Uses the same helper that the
 * runtime callers (POST /members, PATCH /members/[id], DELETE
 * /members/[id], invite-accept, SSO auto-join) use, so the backfill and
 * the live writes stay byte-identical.
 *
 * Usage:
 *   npx tsx prisma/scripts/backfill-isindependent.ts
 *   npx tsx prisma/scripts/backfill-isindependent.ts --dry-run
 */

import prisma from "@/lib/prisma";
import { recomputeConsultantIsIndependent } from "@/lib/api/organizations/membership-transitions";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(
    `[backfill-isindependent] Starting (dry-run=${DRY_RUN ? "yes" : "no"})`,
  );

  const profiles = await prisma.consultantProfile.findMany({
    select: { id: true, isIndependent: true },
  });

  let flipped = 0;
  let unchanged = 0;

  for (const p of profiles) {
    const expectedIndependent =
      (await prisma.membership.count({
        where: {
          consultantProfileId: p.id,
          role: "EXPERT",
          status: "ACTIVE",
          organization: { canHost: true },
        },
      })) === 0;

    if (expectedIndependent === p.isIndependent) {
      unchanged += 1;
      continue;
    }

    if (!DRY_RUN) {
      await recomputeConsultantIsIndependent(prisma, p.id);
    }
    flipped += 1;
    console.log(
      `[backfill-isindependent] ${p.id}: ${p.isIndependent} → ${expectedIndependent}`,
    );
  }

  console.log(
    `[backfill-isindependent] Done. scanned=${profiles.length} flipped=${flipped} unchanged=${unchanged}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-isindependent] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
