/**
 * @jest-environment node
 */

/**
 * A lapsed approved request gives back what its open order's checkout consumed
 * (the referral credit, the discount-code use and the programme engagement): in
 * the same transaction as that order's PENDING→EXPIRED claim, once per claimed
 * row, and never for a row the claim did not move. The real-Postgres twin is
 * `__tests__/db/booking/lapse-returns-what-checkout-consumed.db.test.ts`.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/booking/expiry-notices", () => ({
  notifyConsulteeRequestExpired: jest.fn(),
}));
jest.mock("../../scripts/payments/cleanup-abandoned-payments", () => ({
  cancelPaymentIntent: jest.fn(),
}));

const calls: string[] = [];
const giveBack = (name: string) =>
  jest.fn(async (...a: unknown[]) => {
    const id = typeof a[0] === "string" ? a[0] : a[1];
    const paymentId =
      typeof id === "string" ? id : (id as { paymentId: string }).paymentId;
    calls.push(`${name}:${paymentId}`);
    return name === "engagement"
      ? { reversed: true, engagementsReversed: 1, fullyReversed: true }
      : 0;
  });
const reverseCreditsForPayment = giveBack("credit");
const returnDiscountUse = giveBack("discount");
const reverseBookingUtilization = giveBack("engagement");
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (...a: unknown[]) => reverseCreditsForPayment(...a),
}));
jest.mock("../../lib/payments/checkout/discount-use", () => ({
  returnDiscountUse: (...a: unknown[]) => returnDiscountUse(...a),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: (...a: unknown[]) =>
    reverseBookingUtilization(...a),
}));

import type { Tx } from "../../lib/prisma";
import { lapseApprovedRequest } from "../../lib/booking/lapse-approved-request";

/** `pending` are the open orders a read finds; `claimed` the ones a PENDING CAS still moves. */
function fakeTx(opts: {
  requestMoves: boolean;
  pending: string[];
  claimed: string[];
}) {
  const tx = {
    consultation: {
      findUnique: jest.fn(async () => ({
        status: "APPROVED_PENDING_PAYMENT",
        appointment: { id: "a-1" },
      })),
      updateMany: jest.fn(async () => {
        calls.push("request-cas");
        return { count: opts.requestMoves ? 1 : 0 };
      }),
    },
    appointment: { findFirst: jest.fn(async () => ({ id: "a-1" })) },
    appointmentOccurrence: {
      findMany: jest.fn(async () => []),
      updateManyAndReturn: jest.fn(async () => []),
    },
    payment: {
      findMany: jest.fn(async () =>
        opts.pending.map((id) => ({
          id,
          paymentIntent: `order_${id}`,
          paymentGateway: "RAZORPAY",
          isMockPayment: false,
        })),
      ),
      updateMany: jest.fn(async (q: { where: { id?: string } }) => {
        const id = q.where.id;
        calls.push(`claim:${id ?? "all"}`);
        return {
          count: id ? Number(opts.claimed.includes(id)) : opts.claimed.length,
        };
      }),
      updateManyAndReturn: jest.fn(async () => {
        calls.push("claim:all");
        return opts.claimed.map((id) => ({ id }));
      }),
    },
    bookingStatusHistory: { create: jest.fn(async () => ({})) },
  };
  return tx as unknown as Tx;
}

const lapse = (tx: Tx) =>
  lapseApprovedRequest(tx, {
    kind: "consultation",
    id: "c-1",
    reason: "PAYMENT_LAPSED",
    actorUserId: null,
  });

const gaveBack = (paymentId: string) =>
  calls.filter((c) => c.endsWith(`:${paymentId}`) && !c.startsWith("claim"));

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
});

describe("lapseApprovedRequest gives back what the expired order's checkout consumed", () => {
  it("returns the credit, the code use and the engagement on the same tx, after that order's claim", async () => {
    const tx = fakeTx({
      requestMoves: true,
      pending: ["p-1"],
      claimed: ["p-1"],
    });
    await lapse(tx);
    const payment = (tx as unknown as { payment: { updateMany: jest.Mock } })
      .payment;
    expect(payment.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(reverseCreditsForPayment).toHaveBeenCalledWith("p-1", tx);
    expect(returnDiscountUse).toHaveBeenCalledWith(tx, "p-1");
    expect(reverseBookingUtilization).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ paymentId: "p-1" }),
    );
    expect(gaveBack("p-1").sort()).toEqual([
      "credit:p-1",
      "discount:p-1",
      "engagement:p-1",
    ]);
    const claimAt = calls.findIndex((c) => c.startsWith("claim"));
    expect(claimAt).toBeGreaterThan(calls.indexOf("request-cas"));
    expect(calls.indexOf("credit:p-1")).toBeGreaterThan(claimAt);
  });

  it("returns nothing for an order the claim does not move (captured or already expired)", async () => {
    const tx = fakeTx({ requestMoves: true, pending: ["p-1"], claimed: [] });
    await lapse(tx);
    expect(gaveBack("p-1")).toEqual([]);
  });

  it("a second lapse of the same request returns nothing more", async () => {
    await lapse(
      fakeTx({ requestMoves: true, pending: ["p-1"], claimed: ["p-1"] }),
    );
    const out = await lapse(
      fakeTx({ requestMoves: false, pending: ["p-1"], claimed: ["p-1"] }),
    );
    expect(out.moved).toBe(0);
    expect(gaveBack("p-1")).toHaveLength(3);
  });
});
