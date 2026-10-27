import prisma from "@/lib/prisma";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";

/** An admin cannot disburse a payout they approved; shared by the consultant and organisation rails. */
export async function isMakerCheckerDisbursementBlocked(
  payoutId: string,
  approvedByValue: unknown,
  triggeredByUserId?: string,
): Promise<boolean> {
  const approvedBy =
    typeof approvedByValue === "string" ? approvedByValue : null;
  if (
    !triggeredByUserId ||
    !approvedBy ||
    approvedBy !== triggeredByUserId ||
    approvedBy === "SYSTEM_AUTO_APPROVE"
  ) {
    return false;
  }
  const makerCheckerRequired =
    process.env.PAYOUT_MAKER_CHECKER_REQUIRED !== "false";
  const activeAdminCount =
    typeof (prisma as { user?: { count?: (args: unknown) => Promise<number> } })
      .user?.count === "function"
      ? await prisma.user.count({ where: { role: "ADMIN" } })
      : 2;
  if (!makerCheckerRequired || activeAdminCount <= 1) {
    return false;
  }
  console.warn(
    `[Payouts] Payout ${payoutId} skipped — triggered by the same admin (${triggeredByUserId}) who approved it`,
  );
  await recordSystemEventSafe({
    category: "PAYOUT",
    severity: "WARN",
    message: `PAYOUT_MAKER_CHECKER_DISBURSEMENT_SKIPPED: Payout ${payoutId} approved by ${approvedBy} cannot be disbursed by the same admin`,
    context: { payoutId, approvedBy, triggeredByUserId },
  });
  return true;
}
