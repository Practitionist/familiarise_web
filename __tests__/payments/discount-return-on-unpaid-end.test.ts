/**
 * @jest-environment node
 */

/**
 * A discount-code use is given back only when a PENDING payment ends unpaid,
 * on the door that won the PENDING → terminal CAS; a capture that won keeps it.
 */
jest.mock("@/lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(async () => 0),
}));
jest.mock("@/lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: jest.fn(async () => undefined),
}));
jest.mock("@/scripts/payments/cleanup-abandoned-payments", () => ({
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@/lib/booking/backup-interest", () => ({
  stageNoticesForAppointmentHolds: jest.fn(async () => null),
  flushBackupInterestNotices: jest.fn(),
}));
jest.mock("@/lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: jest.fn(),
}));
jest.mock("@/lib/booking/participants", () => ({
  transitionParticipant: jest.fn(),
}));
jest.mock("@/lib/booking/reschedule-decline", () => ({
  declineOpenReschedules: jest.fn(),
}));
const mockTxRef: { tx: unknown } = { tx: null };
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => unknown) => fn(mockTxRef.tx),
  },
}));

import { expirePendingPaymentsInTx } from "@/lib/booking/pending-payment-expiry";
import { releaseDeclinedRequestHold } from "@/lib/booking/request-route-guards";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import {
  releaseSupersededHolds,
  SUPERSEDED_HOLD_NOTE,
} from "@/lib/payments/checkout/order-reuse";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import type { Tx } from "@/lib/prisma";

function fakeTx(opts: { casWins: boolean; discountCodeId: string | null }) {
  const discountUpdates: unknown[] = [];
  const tx = {
    payment: {
      findMany: jest.fn(async () => [
        {
          id: "pay-1",
          paymentIntent: "order_1",
          paymentGateway: "RAZORPAY",
          isMockPayment: false,
        },
      ]),
      updateMany: jest.fn(async () => ({ count: opts.casWins ? 1 : 0 })),
      findUnique: jest.fn(async () => ({
        discountCodeId: opts.discountCodeId,
      })),
      updateManyAndReturn: jest.fn(async () =>
        opts.casWins ? [{ id: "pay-1", appointmentId: null }] : [],
      ),
    },
    appointment: { findFirst: jest.fn(async () => ({ id: "appt-1" })) },
    discountCode: {
      updateMany: jest.fn(async (args: unknown) => {
        discountUpdates.push(args);
        return { count: 1 };
      }),
    },
  };
  return { tx: tx as unknown as Tx, discountUpdates };
}

describe("discount use on an unpaid end", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the use when this door expires the PENDING payment", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: true,
      discountCodeId: "dc-1",
    });
    await expirePendingPaymentsInTx(tx, {
      appointmentId: "appt-1",
      reason: "booking cancelled before payment",
    });
    expect(discountUpdates).toEqual([
      {
        where: { id: "dc-1", currentUses: { gt: 0 } },
        data: { currentUses: { decrement: 1 } },
      },
    ]);
  });

  it("keeps the use when a capture won the race", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: false,
      discountCodeId: "dc-1",
    });
    await expirePendingPaymentsInTx(tx, {
      appointmentId: "appt-1",
      reason: "booking cancelled before payment",
    });
    expect(discountUpdates).toEqual([]);
  });

  it("returns the use when a consultant declines a request whose hold lapsed", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: true,
      discountCodeId: "dc-1",
    });
    await releaseDeclinedRequestHold(tx, { consultationId: "c-1" });
    expect(discountUpdates).toHaveLength(1);
    expect(reverseBookingUtilization).toHaveBeenCalledWith(tx, {
      paymentId: "pay-1",
      reason: "Request declined by consultant",
    });
  });

  it("gives back the org engagement when a newer checkout supersedes the order", async () => {
    const { tx } = fakeTx({ casWins: true, discountCodeId: null });
    mockTxRef.tx = tx;
    await releaseSupersededHolds({ paymentIds: ["pay-1"], userId: "u-1" });
    expect(reverseBookingUtilization).toHaveBeenCalledWith(tx, {
      paymentId: "pay-1",
      reason: SUPERSEDED_HOLD_NOTE,
    });
  });

  it("touches no code when the checkout used none", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: true,
      discountCodeId: null,
    });
    await returnDiscountUse(tx, "pay-1");
    expect(discountUpdates).toEqual([]);
  });
});
