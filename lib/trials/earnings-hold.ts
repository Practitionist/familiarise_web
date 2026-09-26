import type { Tx } from "@/lib/prisma";
import {
  computeHoldUntil,
  holdHoursFor,
} from "@/lib/payments/payouts/earnings-hold";

/**
 * #1775 C-9 — a paid trial is charged at request, before it is delivered, so
 * its earning is written with holdUntil null. Completion starts the hold (the
 * subscription type's hours, the rate card it settles on). Only rows still
 * waiting are stamped, so a replay or a second completer is a no-op.
 */
export async function stampTrialEarningsHold(
  db: Pick<Tx, "consultantEarnings" | "organizationEarnings">,
  paymentId: string | null,
  completedAt: Date,
): Promise<void> {
  if (!paymentId) return;
  const holdUntil = computeHoldUntil({
    capturedAt: completedAt,
    lastOccurrenceEndsAt: null,
    holdHours: holdHoursFor("SUBSCRIPTION"),
  });
  const waiting = { paymentId, holdUntil: null };
  await db.consultantEarnings.updateMany({
    where: waiting,
    data: { holdUntil },
  });
  await db.organizationEarnings.updateMany({
    where: waiting,
    data: { holdUntil },
  });
}
