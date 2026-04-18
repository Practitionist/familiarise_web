/**
 * Cron: DPDP ConsentArtifact retention sweeper — STUB (Issue #681).
 *
 * STATUS: stub. Counts artifacts past their 7-year retention window but
 * does NOT purge them. Live purge lands in a follow-up PR once the
 * archival pipeline (hashed-only retention for dispute resolution) is
 * finalised.
 *
 * Schedule: weekly, Sunday 03:00 IST.
 */

import prisma from "@/lib/prisma";

export async function runConsentRetentionSweeper(): Promise<{ expired: number }> {
  console.log("[cron][arch4-stub] Consent retention sweeper invoked");

  const now = new Date();
  const expired = await prisma.consentArtifact.count({
    where: { auditRetainedUntil: { lt: now } },
  });

  if (expired > 0) {
    console.warn(
      `[DPDP] ${expired} consent artifacts past retention window; purge deferred to Phase 2b cron.`,
    );
  }

  return { expired };
}
