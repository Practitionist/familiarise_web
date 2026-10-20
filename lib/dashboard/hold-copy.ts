/**
 * Plain-English copy for money that is waiting rather than moving: the
 * new-expert hold, earnings awaiting an organisation, a payout parked while
 * live transfers are off, and the org "Paid out" tile. Pure and Prisma-free so
 * client pages and jest both import it; every number is read from
 * `PAYOUT_CONSTANTS`, never written twice.
 */

import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

/** Tile title for earnings parked on a sponsor organisation that is not yet verified. */
export const AWAITING_ORG_LABEL = "Awaiting organisation verification";

export const AWAITING_ORG_HINT =
  "Earned from sessions an organisation pays for. It moves to Pending once the organisation is verified or pays its first invoice.";

/** Why a new expert's earnings clear later than the standard hold. */
export function newExpertHoldCopy(): string {
  const {
    NEW_EXPERT_EXTRA_HOLD_DAYS: days,
    NEW_EXPERT_TENURE_DAYS: tenure,
    NEW_EXPERT_LIFETIME_SHARE_PAISE: share,
  } = PAYOUT_CONSTANTS;
  return `New experts have ${days} extra days added to each hold, during the first ${tenure} days after your first paid booking or until you have earned ${rupees(share)}.`;
}

/** The organisation Payouts page while ENABLE_LIVE_PAYOUTS is off. */
export const ORG_PAYOUTS_PARKED_COPY =
  "Bank transfers from the platform aren't switched on yet. Approved payouts are calculated and held for you, not failed, and are sent as soon as transfers go live.";

/** The org "Paid out (after TDS)" tile's second line. */
export function paidOutHint(payoutCount: number, tdsPaise: number): string {
  const count = `${payoutCount} payouts`;
  return tdsPaise > 0 ? `${count} · ${rupees(tdsPaise)} TDS withheld` : count;
}
