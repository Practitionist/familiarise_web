import type { Tx } from "@/lib/prisma";

export type ReviewDecision = "RELEASED" | "VOIDED" | "NOT_HELD";

/** HELD -> QUALIFYING; the stamp stops the review rules holding it again, so the next vest settles it. */
export async function releaseHeldReferral(
  tx: Tx,
  referralId: string,
  now: Date,
): Promise<ReviewDecision> {
  const moved = await tx.referral.updateMany({
    where: { id: referralId, status: "HELD" },
    data: { status: "QUALIFYING", reviewReleasedAt: now },
  });
  return moved.count === 1 ? "RELEASED" : "NOT_HELD";
}

/** HELD -> VOID, voiding the referrer's PENDING credit as every other void does. */
export async function voidHeldReferral(
  tx: Tx,
  referralId: string,
  now: Date,
): Promise<ReviewDecision> {
  const moved = await tx.referral.updateMany({
    where: { id: referralId, status: "HELD" },
    data: { status: "VOID", voidReason: "REVIEW_REJECTED" },
  });
  if (moved.count !== 1) return "NOT_HELD";
  await tx.referralCredit.updateMany({
    where: { referralId, state: "PENDING" },
    data: { state: "VOID", voidedAt: now },
  });
  return "VOIDED";
}
