/**
 * The profitability floor. Everything the platform funds on one order — a
 * platform discount code, the referral welcome discount and referral credits
 * together — stays within the platform fee left after the gateway's cut, so no
 * promo makes an order lose money. Client-safe: the checkout preview applies
 * the same cap the server charges.
 */

import { TAX_CONSTANTS } from "@/lib/payments/payouts/constants";
import { prorate } from "@/lib/payments/utils/money";

/** Razorpay's 2% domestic fee plus 18% GST on that fee, in bps of the captured amount. */
export const GATEWAY_COST_BPS = 236;

/**
 * `max(0, fee − gateway estimate)` in paise. The fee is the settlement's own
 * `floor(list × bps / 10 000)`; the gateway estimate is rounded up on the
 * largest amount the order can charge (the list price, plus GST when registered).
 */
export function platformFundedCapPaise(input: {
  listPaise: number;
  /** The take that can fund promo: 0 on a fee-waiver or host-organisation order. */
  platformFeeBps: number;
  gstRegistered: boolean;
}): number {
  const { listPaise, gstRegistered } = input;
  const bps = Math.max(0, input.platformFeeBps);
  if (listPaise <= 0 || bps === 0) return 0;
  const feePaise = prorate(listPaise, bps, 10_000);
  const chargeCeilingPaise = gstRegistered
    ? listPaise + prorate(listPaise, TAX_CONSTANTS.GST_RATE, 100, "round")
    : listPaise;
  const gatewayPaise = prorate(
    chargeCeilingPaise,
    GATEWAY_COST_BPS,
    10_000,
    "ceil",
  );
  return Math.max(0, feePaise - gatewayPaise);
}
