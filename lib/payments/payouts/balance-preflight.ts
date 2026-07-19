import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";

export type BalancePreflight = {
  /** False only on a KNOWN-insufficient balance — the caller holds the batch. */
  ok: boolean;
  /** Fetched balance in paise, or null when unknown (not fetched / bad shape). */
  balancePaise: number | null;
  reason?: string;
};

/**
 * #863 — pre-batch RazorpayX balance check. Runs only when live payouts are on
 * and the gateway is configured (otherwise nothing is wired to leave, so it's a
 * no-op ok). On a KNOWN-insufficient balance it pages ops and returns ok:false,
 * so the caller holds the batch — the rows stay PENDING, the same honest posture
 * as the flag-off path, instead of half-submitting and stranding NEFT.
 *
 * A balance-read failure or unexpected shape fails OPEN (ok:true): a brand-new
 * read dependency must never stall payouts, and RazorpayX's own
 * `queue_if_low_balance` remains the gateway-side backstop.
 */
export async function assertPayoutBalance(
  totalPaise: number,
): Promise<BalancePreflight> {
  if (!ENABLE_LIVE_PAYOUTS || !isRazorpayPayoutsConfigured()) {
    return { ok: true, balancePaise: null };
  }

  const balancePaise = await getRazorpayPayoutsService().getAccountBalance();
  if (balancePaise === null) {
    return { ok: true, balancePaise: null }; // unknown → fail open
  }
  if (balancePaise < totalPaise) {
    const reason = `RazorpayX balance ${balancePaise} < required ${totalPaise} paise`;
    void recordSystemError({
      organizationId: null,
      category: "PAYOUT",
      summary: `RAZORPAYX_BALANCE_INSUFFICIENT — ${reason}`,
      err: new Error(reason),
      context: { balancePaise, totalPaise },
    }).catch(() => {});
    return { ok: false, balancePaise, reason };
  }
  return { ok: true, balancePaise };
}
