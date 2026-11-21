/**
 * @jest-environment node
 */

/**
 * A refund key replays only for the payment, and the amount when one is named,
 * that it was spent on. Anything else answers 422 IDEMPOTENCY_KEY_REUSED and
 * ends no seat. Runs the real doors, eligibility, wrapper and dedupe lookup.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
const mockTransitionParticipant = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("../../lib/booking/participants", () => ({
  ...jest.requireActual("../../lib/booking/participants"),
  transitionParticipant: (...a: unknown[]) => mockTransitionParticipant(...a),
}));
const mockPersistRevocation = jest.fn(async (_i: unknown) => undefined);
const mockRevokeSeat = jest.fn(async (_i: unknown, _g: unknown) => undefined);
jest.mock("../../lib/stream/access-revocation", () => ({
  persistRefundRevocation: (i: unknown) => mockPersistRevocation(i),
  revokeRefundedSeatAccess: (i: unknown, g: unknown) => mockRevokeSeat(i, g),
  persistRefundRevocationInTx: jest.fn(async () => null),
}));

type Spent = { id: string; paymentId: string; amountPaise: number };
const mockStore = { spent: null as (Spent & { dedupeKey: string }) | null };
/** A ₹50 card seat (B, and A whose key is reused) and a credit-funded class seat (C). */
const mockPayments: Record<string, Record<string, unknown>> = {
  "pay-A": { paymentIntent: "order_A", userId: "buyer-A" },
  "pay-B": { paymentIntent: "order_B", userId: "buyer-B" },
  "pay-C": { paymentIntent: "free_C", userId: "buyer-C", amount: 0 },
  "pay-D": { paymentIntent: "order_D", userId: "buyer-D", amount: 5_000_000 },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    opsActionLog: { create: async () => ({ id: "ops_1" }) },
    // Two active admins, so an amount above the threshold would be held.
    user: { count: async () => 2 },
    refund: {
      findUnique: async ({ where }: { where: { dedupeKey?: string } }) =>
        where.dedupeKey && mockStore.spent?.dedupeKey === where.dedupeKey
          ? { ...mockStore.spent, status: "SUCCEEDED" }
          : null,
      updateMany: async () => ({ count: 0 }),
    },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = mockPayments[where.id];
        return row
          ? {
              id: where.id,
              paymentStatus: "SUCCEEDED",
              amount: 5_000,
              originalAmount: 5_000,
              // The spent refund counts against its own payment's balance.
              refunds:
                mockStore.spent?.paymentId === where.id
                  ? [
                      {
                        amountPaise: mockStore.spent.amountPaise,
                        status: "SUCCEEDED",
                      },
                    ]
                  : [],
              disputes: [],
              creditUsages: [{ amount: 5_000 }],
              refundOwedKey: null,
              appointmentId: "appt-1",
              appointment: { classId: "class-1", subscriptionId: null },
              ...row,
            }
          : null;
      },
    },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

import { NextRequest } from "next/server";
import { POST as issue } from "../../app/api/admin/refunds/issue/route";
import { POST as credits } from "../../app/api/admin/refunds/credits/route";
import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";

const KEY = "11111111-2222-4333-8444-555555555555";
const ROUTE = { params: Promise.resolve({}) };

const post = (
  door: (req: NextRequest, route: typeof ROUTE) => Promise<Response>,
  url: string,
  body: Record<string, unknown>,
) =>
  door(
    new NextRequest(url, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: KEY,
        reason: "learner asked for a refund",
        ...body,
      }),
    }),
    ROUTE,
  );
const issueFor = (body: Record<string, unknown>) =>
  post(issue, "https://x.test/api/admin/refunds/issue", body);

function spend(dedupeKey: string, spent: Spent) {
  mockStore.spent = { ...spent, dedupeKey };
}

const noSeatEnded = () => {
  expect(mockTransitionParticipant).not.toHaveBeenCalled();
  expect(mockPersistRevocation).not.toHaveBeenCalled();
  expect(mockRevokeSeat).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.spent = null;
});

describe("the issue door", () => {
  it("refuses payment A's key on payment B with 422 and leaves B's seat alone", async () => {
    spend(`ops:${KEY}`, {
      id: "ref-A",
      paymentId: "pay-A",
      amountPaise: 5_000,
    });

    const res = await issueFor({ paymentId: "pay-B" });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    noSeatEnded();
  });

  it("replays the key on its own payment, ending only that payment's seat", async () => {
    spend(`ops:${KEY}`, {
      id: "ref-B",
      paymentId: "pay-B",
      amountPaise: 5_000,
    });

    const res = await issueFor({ paymentId: "pay-B" });

    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ refundId: "ref-B" });
    expect(mockTransitionParticipant).toHaveBeenCalledWith(
      expect.anything(),
      { paymentId: "pay-B" },
      "REFUNDED",
      expect.anything(),
    );
    expect(mockPersistRevocation).toHaveBeenCalledWith({
      refundId: "ref-B",
      payerUserId: "buyer-B",
    });
  });

  it("refuses the same key with a different explicit amount", async () => {
    spend(`ops:${KEY}`, {
      id: "ref-B",
      paymentId: "pay-B",
      amountPaise: 5_000,
    });

    const res = await issueFor({ paymentId: "pay-B", amountPaise: 2_000 });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    noSeatEnded();
  });

  it("replays an approved ₹30,000 override with the stored refund, opening no second proposal", async () => {
    spend(`ops:${KEY}`, {
      id: "ref-D",
      paymentId: "pay-D",
      amountPaise: 3_000_000,
    });

    const res = await issueFor({ paymentId: "pay-D", tierOverridePct: 60 });

    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({
      refundId: "ref-D",
      amountRefundedPaise: 3_000_000,
    });
  });

  it("replays a ladder override at the amount it sent, without re-pricing it", async () => {
    spend(`ops:${KEY}`, {
      id: "ref-B",
      paymentId: "pay-B",
      amountPaise: 3_500,
    });

    const res = await issueFor({ paymentId: "pay-B", tierOverridePct: 70 });

    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({
      refundId: "ref-B",
      amountRefundedPaise: 3_500,
    });
  });
});

it("the credits door refuses another payment's key with 422", async () => {
  spend(`ops:credits:${KEY}`, {
    id: "ref-A",
    paymentId: "pay-A",
    amountPaise: 0,
  });

  const res = await post(credits, "https://x.test/api/admin/refunds/credits", {
    paymentId: "pay-C",
    sessions: 1,
  });

  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
});

it.each(["pay-B", "pay-C"])(
  "the booking writer refuses another payment's key on %s and ends no seat",
  async (paymentId) => {
    spend("cancel:appt-1:pay-A", {
      id: "ref-A",
      paymentId: "pay-A",
      amountPaise: 5_000,
    });

    await expect(
      refundBookingPayment({
        paymentId,
        reason: "cancellation",
        dedupeKey: "cancel:appt-1:pay-A",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    noSeatEnded();
  },
);
