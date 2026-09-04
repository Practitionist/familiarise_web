/**
 * #1377 — the two behavioural changes in the Razorpay productionization pass.
 *
 * 1. A RazorpayX payout that reaches the terminal `failed` state must map to
 *    FAILED. It used to fall through to the `default` arm and read as PENDING,
 *    which left the earnings BATCHED against a payout the bank had refused.
 * 2. Rotating `RAZORPAY_WEBHOOK_SECRET` must not drop the deliveries signed
 *    with the old secret during the cutover, because Razorpay disables a
 *    webhook that fails for 24 hours and lost events cannot be replayed.
 */
import crypto from "node:crypto";

import {
  isPayoutEventName,
  matchRazorpayWebhookSecret,
  resolveRazorpayPaymentSecrets,
  verifyRazorpaySignature,
} from "@/app/api/webhooks/razorpay/signature";
import { RazorpayPayoutsService } from "@/lib/payments/payouts/razorpay-payouts";

const RAW_BODY = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_test" } } },
});

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("RazorpayX payout status mapping", () => {
  const service = new RazorpayPayoutsService({
    keyId: "rzp_test_key",
    keySecret: "secret",
    accountNumber: "2323230000000000",
  });

  it("maps every terminal RazorpayX status to a terminal internal status", () => {
    expect(service.mapPayoutStatus("failed")).toBe("FAILED");
    expect(service.mapPayoutStatus("rejected")).toBe("FAILED");
    expect(service.mapPayoutStatus("reversed")).toBe("FAILED");
    expect(service.mapPayoutStatus("cancelled")).toBe("CANCELLED");
    expect(service.mapPayoutStatus("processed")).toBe("COMPLETED");
  });

  it("keeps the intermediate statuses non-terminal so the reconciler keeps polling", () => {
    expect(service.mapPayoutStatus("queued")).toBe("PENDING");
    expect(service.mapPayoutStatus("pending")).toBe("PENDING");
    expect(service.mapPayoutStatus("processing")).toBe("PROCESSING");
  });
});

// The resolver takes the environment as an argument precisely so these cases
// need no process.env mutation and cannot leak into a sibling suite.
describe("Razorpay webhook secret rotation grace", () => {
  it("offers only the current secret when no rotation is in flight", () => {
    const secrets = resolveRazorpayPaymentSecrets({
      RAZORPAY_WEBHOOK_SECRET: "current_secret",
    });

    expect(secrets).toEqual([{ role: "current", value: "current_secret" }]);
  });

  it("offers the previous secret second, and never duplicates the current one", () => {
    expect(
      resolveRazorpayPaymentSecrets({
        RAZORPAY_WEBHOOK_SECRET: "new_secret",
        RAZORPAY_WEBHOOK_SECRET_PREVIOUS: "old_secret",
      }),
    ).toEqual([
      { role: "current", value: "new_secret" },
      { role: "previous", value: "old_secret" },
    ]);

    expect(
      resolveRazorpayPaymentSecrets({
        RAZORPAY_WEBHOOK_SECRET: "same",
        RAZORPAY_WEBHOOK_SECRET_PREVIOUS: "same",
      }),
    ).toEqual([{ role: "current", value: "same" }]);
  });

  it("accepts a delivery signed with either secret and reports which one matched", () => {
    const candidates = resolveRazorpayPaymentSecrets({
      RAZORPAY_WEBHOOK_SECRET: "new_secret",
      RAZORPAY_WEBHOOK_SECRET_PREVIOUS: "old_secret",
    });

    expect(
      matchRazorpayWebhookSecret(
        RAW_BODY,
        sign(RAW_BODY, "new_secret"),
        candidates,
      ),
    ).toBe("current");
    expect(
      matchRazorpayWebhookSecret(
        RAW_BODY,
        sign(RAW_BODY, "old_secret"),
        candidates,
      ),
    ).toBe("previous");
    expect(
      matchRazorpayWebhookSecret(
        RAW_BODY,
        sign(RAW_BODY, "attacker_secret"),
        candidates,
      ),
    ).toBeNull();
  });

  it("rejects a malformed signature instead of throwing out of timingSafeEqual", () => {
    expect(() =>
      verifyRazorpaySignature(RAW_BODY, "not-a-hex-digest", "current_secret"),
    ).not.toThrow();
    expect(
      verifyRazorpaySignature(RAW_BODY, "not-a-hex-digest", "current_secret"),
    ).toBe(false);
    expect(
      verifyRazorpaySignature(
        RAW_BODY,
        sign(RAW_BODY, "current_secret").slice(0, 63),
        "current_secret",
      ),
    ).toBe(false);
  });

  it("only classifies payout.* bodies as eligible for the RazorpayX secret", () => {
    expect(
      isPayoutEventName(JSON.stringify({ event: "payout.processed" })),
    ).toBe(true);
    expect(isPayoutEventName(RAW_BODY)).toBe(false);
    expect(isPayoutEventName("{ not json")).toBe(false);
  });
});
