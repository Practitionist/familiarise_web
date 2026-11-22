/**
 * The shared half of the credits rail's transaction double, and the credit-funded payment its
 * suites refund. A suite spreads the delegates into its own `tx` and adds its earnings and payment reads.
 */

/** A ₹1,000 list price paid wholly in credit, as the writer reads the payment. */
export const CREDIT_FUNDED = {
  paymentIntent: "free_1730000000_abc",
  amount: 0,
  originalAmount: 100_000,
};

/** The participant, credit-usage, revocation and refund delegates every credits-rail run touches. */
export function creditRailTxBase() {
  const refund = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(async (...a: unknown[]) => {
      refund.update(...a);
      return { count: 1 };
    }),
  };
  return {
    appointmentParticipant: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
      // The REFUNDED stamp's pre-read for event learner seats; a 1:1 seat has none.
      findMany: jest.fn().mockResolvedValue([]),
    },
    referralCreditUsage: { findMany: jest.fn(), aggregate: jest.fn() },
    streamRevocationRetry: { updateMany: jest.fn(), createMany: jest.fn() },
    appointment: { findUnique: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn(), count: jest.fn() },
    refund,
  };
}

/** The booking's ₹1,180 of credit is still consumed, so the rail has something to restore. */
export function creditStillConsumed(usage: Record<string, jest.Mock>): void {
  const { aggregate } = usage;
  if (!aggregate)
    throw new Error("the tx double has no referralCreditUsage.aggregate");
  aggregate.mockResolvedValue({
    _sum: { amount: 118_000 },
    _count: { _all: 1 },
  });
}
