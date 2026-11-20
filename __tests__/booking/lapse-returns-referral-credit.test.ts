/**
 * @jest-environment node
 */

/**
 * A lapsed approved request gives back the referral credit its open order used:
 * in the same transaction as the PENDING→EXPIRED claim, once per claimed row,
 * and never for a row the claim did not move. The real-Postgres twin is
 * `__tests__/db/booking/lapse-returns-referral-credit.db.test.ts`.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/booking/expiry-notices", () => ({
  notifyConsulteeRequestExpired: jest.fn(),
}));
const reverseCreditsForPayment = jest.fn(
  async (_paymentId: string, _tx: unknown) => 0,
);
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (paymentId: string, tx: unknown) =>
    reverseCreditsForPayment(paymentId, tx),
}));

import type { Tx } from "../../lib/prisma";
import { lapseApprovedRequest } from "../../lib/booking/lapse-approved-request";

function fakeTx(opts: { requestMoves: boolean; claimed: string[] }) {
  const calls: string[] = [];
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
      // Either claim shape answers with the same rows, so the pins read the outcome, not the call.
      updateMany: jest.fn(async () => {
        calls.push("payment-claim");
        return { count: opts.claimed.length };
      }),
      updateManyAndReturn: jest.fn(async () => {
        calls.push("payment-claim");
        return opts.claimed.map((id) => ({ id }));
      }),
    },
    bookingStatusHistory: { create: jest.fn(async () => ({})) },
  };
  reverseCreditsForPayment.mockImplementation(async (paymentId) => {
    calls.push(`reverse:${paymentId}`);
    return 0;
  });
  return { tx: tx as unknown as Tx, calls };
}

const lapse = (tx: Tx) =>
  lapseApprovedRequest(tx, {
    kind: "consultation",
    id: "c-1",
    reason: "PAYMENT_LAPSED",
    actorUserId: null,
  });

beforeEach(() => reverseCreditsForPayment.mockReset());

describe("lapseApprovedRequest returns the credit of the order it expires", () => {
  it("reverses each claimed payment's credit on the same tx, after the claim", async () => {
    const { tx, calls } = fakeTx({ requestMoves: true, claimed: ["p-1"] });
    await lapse(tx);
    expect(reverseCreditsForPayment).toHaveBeenCalledTimes(1);
    expect(reverseCreditsForPayment).toHaveBeenCalledWith("p-1", tx);
    expect(calls).toEqual(["request-cas", "payment-claim", "reverse:p-1"]);
  });

  it("reverses nothing when the claim moves no row (captured or already expired)", async () => {
    const { tx } = fakeTx({ requestMoves: true, claimed: [] });
    await lapse(tx);
    expect(reverseCreditsForPayment).not.toHaveBeenCalled();
  });

  it("a second lapse of the same request reverses nothing more", async () => {
    const first = fakeTx({ requestMoves: true, claimed: ["p-1"] });
    await lapse(first.tx);
    const second = fakeTx({ requestMoves: false, claimed: ["p-1"] });
    const out = await lapse(second.tx);
    expect(out.moved).toBe(0);
    expect(second.calls).toEqual(["request-cas"]);
    expect(reverseCreditsForPayment).toHaveBeenCalledTimes(1);
  });
});
