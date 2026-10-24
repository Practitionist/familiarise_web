import type { Db } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { purgeTombstonedDocuments } from "./document-purge";

/** Bounded passes; each pass purges up to the purge core's own 1,000-row ceiling. */
const MAX_ERASURE_PASSES = 5;

/**
 * Erasure covers session documents: every thread on bookings where the user
 * is the learner, and every file the user shared as the expert. Live rows are
 * tombstoned with ACCOUNT_ERASURE, then every tombstone in scope is purged
 * whatever its earlier reason, objects before rows.
 * Returns failure lines for the erasure request; reports once per run.
 */
export async function eraseUserSessionDocuments(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const asLearner = {
    OR: [
      { consultation: { requestedBy: { userId } } },
      { subscription: { requestedBy: { userId } } },
      { trial: { consulteeProfile: { userId } } },
    ],
  };
  const asExpert = {
    OR: [
      { consultation: { consultationPlan: { consultantProfile: { userId } } } },
      { subscription: { subscriptionPlan: { consultantProfile: { userId } } } },
      { trial: { consultantProfile: { userId } } },
    ],
  };
  const scope = {
    OR: [
      { appointment: asLearner },
      { appointment: asExpert, uploadedByRole: "CONSULTANT" as const },
    ],
  };
  try {
    const totals = { purged: 0, failedStorage: 0, failedRows: 0 };
    let remaining = 0;
    // A tombstone pass followed by a purge pass, repeated because a purge is
    // capped and an upload can race the tombstone. The request is complete
    // only when no live row and no tombstone in scope is left.
    for (let pass = 0; pass < MAX_ERASURE_PASSES; pass += 1) {
      await db.appointmentDocument.updateMany({
        where: { ...scope, deletedAt: null },
        data: { deletedAt: now, removalReason: "ACCOUNT_ERASURE" },
      });
      const counts = await purgeTombstonedDocuments(scope, db);
      totals.purged += counts.purged;
      totals.failedStorage += counts.failedStorage;
      totals.failedRows += counts.failedRows;
      remaining = counts.remaining;
      if (counts.remaining > 0) continue;
      const live = await db.appointmentDocument.count({
        where: { ...scope, deletedAt: null },
      });
      if (live === 0) break;
    }
    const liveLeft = await db.appointmentDocument.count({
      where: { ...scope, deletedAt: null },
    });
    // Report the rows actually left, not the sum of every pass's failures.
    const left = remaining + liveLeft;
    if (left === 0) return [];
    reportSentryError(new Error("Session document erasure incomplete"), {
      subsystem: "compliance",
      op: "scrubUser.eraseUserSessionDocuments",
      extra: { userId, ...totals, remaining, liveLeft },
    });
    return [
      `session_documents: ${left} file(s) not confirmed deleted — re-run required`,
    ];
  } catch (error) {
    reportSentryError(error, {
      subsystem: "compliance",
      op: "scrubUser.eraseUserSessionDocuments",
      extra: { userId },
    });
    return ["session_documents: erasure not completed — re-run required"];
  }
}
