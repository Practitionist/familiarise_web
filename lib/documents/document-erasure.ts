import type { Db } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { purgeTombstonedDocuments } from "./document-purge";

/**
 * Erasure covers session documents: every thread on bookings where the user
 * is the learner, and every file the user shared as the expert. Rows are
 * tombstoned with ACCOUNT_ERASURE and purged at once, objects before rows.
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
    await db.appointmentDocument.updateMany({
      where: { ...scope, deletedAt: null },
      data: { deletedAt: now, removalReason: "ACCOUNT_ERASURE" },
    });
    const counts = await purgeTombstonedDocuments(
      { ...scope, removalReason: "ACCOUNT_ERASURE" },
      db,
    );
    const left = counts.failedStorage + counts.failedRows;
    if (left === 0) return [];
    reportSentryError(new Error("Session document erasure incomplete"), {
      subsystem: "compliance",
      op: "scrubUser.eraseUserSessionDocuments",
      extra: { userId, ...counts },
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
