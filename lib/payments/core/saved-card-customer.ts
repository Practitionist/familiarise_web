import { ENABLE_SAVED_CARDS } from "@/lib/feature-flags";
import { reportSentryError } from "@/lib/observability/report";
import type { PaymentGateway } from "@prisma/client";

/**
 * The Razorpay Customer id a personal checkout should mint its order against,
 * or `undefined` when saved cards are off (#1771 row 1).
 *
 * Fail-soft on purpose: a Customer API outage costs the buyer the save-card
 * offer, never the checkout. The Razorpay core is imported lazily so checkout
 * keeps its #1219 posture of not evaluating the gateway module at load.
 */
export async function savedCardCustomerId(
  userId: string,
  gateway: PaymentGateway = "RAZORPAY",
  isMockPayment = false,
): Promise<string | undefined> {
  if (!ENABLE_SAVED_CARDS || gateway !== "RAZORPAY" || isMockPayment) {
    return undefined;
  }
  try {
    const { ensureRazorpayCustomer } = await import("./razorpay");
    return await ensureRazorpayCustomer(userId);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "payments",
      level: "warning",
      tags: { provider: "razorpay", op: "ensureRazorpayCustomer" },
    });
    return undefined;
  }
}
