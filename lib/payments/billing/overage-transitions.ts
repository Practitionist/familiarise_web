/**
 * #778 elegance — the OverageEvent chargeStatus state machine, in one guarded
 * transition. Deliberately dependency-light (Prisma types only) so the metering
 * + settlement call sites can import it without dragging in heavy graphs
 * (Novu/notifications live in `overage-settlement.ts`).
 *
 * Lifecycle (one-way; corrections are new events / counter-entries, never
 * mutations of charged rows):
 *
 *   PENDING ─┬─▶ ACCRUED ──▶ CHARGED        (CHARGE_ORG: rollup → invoice paid)
 *            ├─▶ CHARGED                     (CHARGE_MEMBER: gateway webhook)
 *            ├─▶ FAILED ──▶ PENDING          (CHARGE_MEMBER: abandon → retry)
 *            └─▶ REVERSED                     (booking refunded)
 *   ACCRUED / FAILED ──▶ REVERSED            (refund of an un-charged overage)
 *   CHARGED ──▶ (terminal)                   reversal needs a credit note (#716)
 *   BLOCKED ──▶ (terminal)                   set at creation only
 */
import type { OverageChargeStatus, Prisma } from "@prisma/client";

// The only from-states each target may be reached from. Baked into the update
// WHERE so an illegal transition (e.g. re-charging a REVERSED event, or
// downgrading a CHARGED one) simply matches zero rows — the guard IS the filter.
const ALLOWED_FROM: Record<OverageChargeStatus, OverageChargeStatus[]> = {
  PENDING: ["FAILED"], // member retry after an abandoned side-charge
  ACCRUED: ["PENDING"], // CHARGE_ORG rolled onto an issued invoice
  CHARGED: ["PENDING", "ACCRUED"], // money collected (member webhook / invoice paid)
  FAILED: ["PENDING"], // member side-charge abandoned
  REVERSED: ["PENDING", "ACCRUED", "FAILED"], // booking refunded before collection
  BLOCKED: [], // set at creation only
};

/**
 * Guarded chargeStatus transition. `where` selects the event(s) (by id,
 * paymentId, bookingUtilization, …); the allowed-from guard is appended so only
 * legal transitions take effect. Returns the number of rows moved.
 */
export async function transitionOverage(
  // Only needs the overageEvent delegate — narrowed so every client shape
  // (TransactionClient, the cap-helper's CapTx, or the root client) fits.
  tx: Pick<Prisma.TransactionClient, "overageEvent">,
  where: Prisma.OverageEventWhereInput,
  to: OverageChargeStatus,
  data?: {
    paymentId?: string | null;
    invoiceLineItemId?: string | null;
    settledAt?: Date | null;
  },
): Promise<number> {
  const res = await tx.overageEvent.updateMany({
    where: { ...where, chargeStatus: { in: ALLOWED_FROM[to] } },
    data: { chargeStatus: to, ...data },
  });
  return res.count;
}
