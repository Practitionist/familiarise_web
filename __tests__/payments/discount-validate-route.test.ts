/**
 * @jest-environment node
 */

/**
 * #1584 P1-FX04c — POST /api/payments/discounts/validate re-implemented the
 * discount arithmetic and skipped the currency guard, so the preview could
 * disagree with checkout and a FIXED_AMOUNT non-INR code previewed as valid
 * and then failed at charge. The route now calls `computeDiscountPaise` and
 * `validateDiscountCurrency`, the same pair checkout uses.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "user_1" } })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  discountLimiter: {},
}));
const findUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    discountCode: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/payments/discounts/validate/route";
import { computeDiscountPaise } from "../../lib/payments/pricing/derive-checkout-amount";

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/payments/discounts/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const base = {
  code: "SAVE25",
  isActive: true,
  expiresAt: null,
  maxUses: null,
  currentUses: 0,
  currency: "INR",
};

beforeEach(() => jest.clearAllMocks());

describe("discount preview shares checkout's arithmetic and guard", () => {
  it("previews the same paise computeDiscountPaise derives for a capped PERCENTAGE code", async () => {
    const code = {
      ...base,
      discountType: "PERCENTAGE",
      discountValue: 25,
      maxDiscount: 20_000,
    };
    findUnique.mockResolvedValue(code);

    const res = await post({ code: "save25", amount: 118_000 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.discountAmount).toBe(
      computeDiscountPaise(118_000, {
        discountType: "PERCENTAGE",
        discountValue: 25,
        maxDiscount: 20_000,
      }),
    );
    expect(body.discountAmount).toBe(20_000);
  });

  it("previews a FIXED_AMOUNT code in another currency as invalid", async () => {
    findUnique.mockResolvedValue({
      ...base,
      discountType: "FIXED_AMOUNT",
      discountValue: 5_000,
      maxDiscount: null,
      currency: "USD",
    });

    const res = await post({ code: "save25", amount: 118_000 });

    expect(res.status).toBe(400);
    expect((await res.json()).valid).toBe(false);
  });

  it("refuses a negative amount at the edge and previews zero as a zero discount", async () => {
    findUnique.mockResolvedValue(base);

    expect((await post({ code: "save25", amount: -1 })).status).toBe(400);
    const zero = await post({ code: "save25", amount: 0 });
    expect(zero.status).toBe(200);
    expect((await zero.json()).discountAmount ?? 0).toBe(0);
  });
});
