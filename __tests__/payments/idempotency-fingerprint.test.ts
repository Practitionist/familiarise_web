/**
 * @jest-environment node
 */

/**
 * A checkout replay under the same key must carry the same priced inputs: a
 * coupon, credits, org or window changed after the first click is a new
 * attempt, never the old order at the old price.
 */
const findFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { payment: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

import {
  checkoutRequestFingerprint,
  replayByIdempotencyKey,
} from "../../lib/payments/operations/checkout-replay";

const base = {
  appointmentType: "CONSULTATION" as const,
  planId: "plan-1",
  startsAt: "2030-01-01T10:00:00.000Z",
  endsAt: "2030-01-01T11:00:00.000Z",
  paymentGateway: "RAZORPAY" as const,
};

describe("checkout request fingerprint", () => {
  it("is stable for the same priced inputs and moves with each of them", () => {
    const fp = checkoutRequestFingerprint(base);
    expect(checkoutRequestFingerprint({ ...base })).toBe(fp);
    expect(
      checkoutRequestFingerprint({ ...base, discountCode: "SAVE10" }),
    ).not.toBe(fp);
    expect(
      checkoutRequestFingerprint({ ...base, useReferralCredits: true }),
    ).not.toBe(fp);
    expect(
      checkoutRequestFingerprint({ ...base, organizationId: "org-1" }),
    ).not.toBe(fp);
    expect(
      checkoutRequestFingerprint({
        ...base,
        startsAt: "2030-01-01T12:00:00.000Z",
      }),
    ).not.toBe(fp);
    // Notes and display currency do not change what is charged.
    expect(checkoutRequestFingerprint({ ...base, notes: "hi" })).toBe(fp);
    expect(
      checkoutRequestFingerprint({ ...base, displayCurrency: "USD" }),
    ).toBe(fp);
    expect(fp).toHaveLength(64);
  });

  it("reads one instant the same however it is spelled", () => {
    expect(
      checkoutRequestFingerprint({
        ...base,
        startsAt: "2030-01-01T10:00:00Z",
        endsAt: "2030-01-01T11:00:00Z",
      }),
    ).toBe(checkoutRequestFingerprint(base));
  });
});

describe("replayByIdempotencyKey × fingerprint", () => {
  const stored = {
    paymentIntent: "order_1",
    paymentStatus: "PENDING",
    paymentGateway: "RAZORPAY",
    amount: 100_000,
    currency: "INR",
    appointmentId: "apt-1",
    isMockPayment: false,
    expiresAt: new Date(Date.now() + 600_000),
  };

  it("refuses to replay an order minted for different priced inputs", async () => {
    findFirst.mockResolvedValueOnce({
      ...stored,
      requestFingerprint: checkoutRequestFingerprint(base),
    });
    const result = await replayByIdempotencyKey(
      "user-1",
      "key-1",
      checkoutRequestFingerprint({ ...base, discountCode: "SAVE10" }),
    );
    expect(result).toBe("fingerprint-mismatch");
  });

  it("replays the open order for the same priced inputs", async () => {
    const fp = checkoutRequestFingerprint(base);
    findFirst.mockResolvedValueOnce({ ...stored, requestFingerprint: fp });
    const result = await replayByIdempotencyKey("user-1", "key-1", fp);
    expect(result).not.toBe("fingerprint-mismatch");
    expect(
      result && result !== "fingerprint-mismatch" && (await result.json()),
    ).toMatchObject({
      reused: true,
      orderId: "order_1",
    });
  });

  it("hands a lapsed hold back with its past deadline, which the client refuses to open", async () => {
    const fp = checkoutRequestFingerprint(base);
    const lapsedAt = new Date(Date.now() - 60_000);
    findFirst.mockResolvedValueOnce({
      ...stored,
      expiresAt: lapsedAt,
      requestFingerprint: fp,
    });
    const result = await replayByIdempotencyKey("user-1", "key-1", fp);
    expect(
      result && result !== "fingerprint-mismatch" && (await result.json()),
    ).toMatchObject({
      reused: true,
      holdExpiresAt: lapsedAt.toISOString(),
    });
  });
});
