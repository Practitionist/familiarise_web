/**
 * @jest-environment node
 */

/**
 * A subscription cancel must not pay twice for a session already refunded on
 * its own (a void settled one unit, an incident refund).
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));

import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import type { Tx } from "@/lib/prisma";

const HOUR = 3_600_000;
const GROSS = 1_000_000;

describe("subscription quote nets per-session refunds already paid", () => {
  it("returns ₹7,000 for 7 undelivered sessions when a void was already refunded ₹1,000", () => {
    // 10 sessions, 2 delivered, session 3 voided and refunded one unit,
    // 7 never scheduled.
    const quote = quoteBookingRefund({
      policy: null,
      hoursUntilNextSession: null,
      slotsTotal: 3,
      sessionsRefunded: 0,
      sessionsRemaining: 0,
      isSubscription: true,
      isConsultantInitiated: false,
      isFreeCreditFunded: false,
      grossPaise: GROSS,
      refundablePaise: GROSS - 100_000,
      sessionsTotal: 10,
      sessionsCompleted: 2,
      scheduledStarts: [],
      alreadyRefundedPaise: 100_000,
    });
    expect(quote.refundPaise).toBe(700_000);
    // 7,000 of the 8,000 undelivered base.
    expect(quote.refundPct).toBe(87.5);
  });

  it("an untouched plan with no prior refund still refunds the whole price", () => {
    const quote = quoteBookingRefund({
      policy: null,
      hoursUntilNextSession: null,
      slotsTotal: 0,
      sessionsRefunded: 0,
      sessionsRemaining: 0,
      isSubscription: true,
      isConsultantInitiated: false,
      isFreeCreditFunded: false,
      grossPaise: GROSS,
      refundablePaise: GROSS,
      sessionsTotal: 10,
      sessionsCompleted: 0,
      scheduledStarts: [],
      alreadyRefundedPaise: 0,
    });
    expect(quote.refundPaise).toBe(GROSS);
  });

  it("the refund context reads the per-session refunds of the subscription's payment", async () => {
    // Per-session refunds answer the first read; money-only support remedies the second.
    const refundFindMany = jest.fn(
      async (args: { where: { supportRecommendation?: unknown } }) =>
        args.where.supportRecommendation
          ? [{ amountPaise: 30_000 }]
          : [
              {
                paymentId: "pay-sub",
                dedupeKey: "occ:o-1:pay:pay-sub",
                amountPaise: 100_000,
              },
            ],
    );
    const db = {
      appointment: {
        findFirst: jest.fn(async () => ({
          id: "appt-sub",
          cancellationPolicy: null,
          payment: [
            {
              id: "pay-sub",
              amount: GROSS,
              paymentIntent: "order_sub",
              refunds: [{ amountPaise: 100_000, status: "SUCCEEDED" }],
              disputes: [],
            },
          ],
          subscription: {
            sessionsTotal: 10,
            subscriptionPlan: { totalSessions: 10 },
            requestedBy: { userId: "user-buyer" },
          },
          consultation: null,
          trial: null,
          occurrences: [1, 2].map((n) => ({
            startsAt: new Date(Date.now() - n * 7 * 24 * HOUR),
            endsAt: new Date(Date.now() - n * 7 * 24 * HOUR + HOUR),
            ordinal: n,
            completionStatus: "COMPLETED",
            isTentative: false,
          })),
        })),
      },
      appointmentOccurrence: { findMany: jest.fn(async () => []) },
      rescheduleRequest: { findMany: jest.fn(async () => []) },
      refund: { findMany: refundFindMany },
    } as unknown as Tx;

    const ctx = await resolveBookingRefundContext(
      { subscriptionId: "sub-1" },
      undefined,
      db,
    );
    expect(ctx.alreadyRefundedPaise).toBe(130_000);
    // A session-count remedy is netted through sessionsRefunded, never as money.
    expect(refundFindMany.mock.calls[1]).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          supportRecommendation: { is: { sessionsRemoved: null } },
        }),
      }),
    ]);
    expect(ctx.windowState).toBe("BEFORE");
    const where = (
      refundFindMany.mock.calls[0] as unknown as [
        { where: { paymentId: unknown } },
      ]
    )[0].where;
    expect(where.paymentId).toEqual({ in: ["pay-sub"] });
  });
});

describe("a credit-funded subscription cancelled after delivery", () => {
  const base = {
    policy: null,
    hoursUntilNextSession: null,
    slotsTotal: 10,
    sessionsRefunded: 0,
    sessionsRemaining: 0,
    isSubscription: true,
    isConsultantInitiated: false,
    isFreeCreditFunded: true,
    grossPaise: 0,
    refundablePaise: 0,
    sessionsTotal: 12,
    scheduledStarts: [],
  };

  it("never restores the whole credit once a session was delivered", () => {
    const quote = quoteBookingRefund({ ...base, sessionsCompleted: 10 });
    expect(quote.creditRestoresInFull).toBe(false);
    expect(quote.creditReturnNeedsReview).toBe(true);
    expect(quote.refundPaise).toBe(0);
  });

  it("restores an untouched credit-funded plan in full", () => {
    const quote = quoteBookingRefund({
      ...base,
      slotsTotal: 0,
      sessionsCompleted: 0,
    });
    expect(quote.creditRestoresInFull).toBe(true);
    expect(quote.creditReturnNeedsReview).toBe(false);
  });

  it("queues nothing when the ladder owes the undelivered sessions nothing", () => {
    // Two sessions left, both scheduled inside the 0% tier.
    const soon = Date.now() + 3_600_000;
    const quote = quoteBookingRefund({
      ...base,
      sessionsTotal: 12,
      sessionsCompleted: 10,
      scheduledStarts: [soon, soon + 1_800_000],
    });
    expect(quote.creditReturnNeedsReview).toBe(false);
  });
});
