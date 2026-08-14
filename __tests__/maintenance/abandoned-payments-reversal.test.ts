/**
 * @jest-environment node
 */

/**
 * #1169 — referral-credit reversal in the abandoned-payment sweeper.
 *
 * Deleting an abandoned Appointment cascades to Payment and on to
 * ReferralCreditUsage, so the usage rows vanish while the ReferralCredit they
 * were drawn from keeps its inflated `usedAmount`. The credit is then gone for
 * good: the consultee paid nothing, sat through no session, and lost the
 * balance anyway. The sweeper therefore has to hand the credits back BEFORE it
 * deletes anything, in the same transaction.
 *
 * Ordering is the whole point of these tests — a reversal that runs after the
 * cascade has nothing left to read.
 */

const order: string[] = [];

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: { findUnique: jest.fn(), update: jest.fn() },
    slotOfAppointment: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    consultation: { delete: jest.fn() },
    subscription: { delete: jest.fn() },
  };
  const client = {
    ...tx,
    appointment: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
  return { __esModule: true, default: client };
});

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  cancelRazorpayOrder: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("stripe", () => ({
  __esModule: true,
  default: class {
    paymentIntents = { cancel: jest.fn() };
  },
}));

// The lock is exercised in __tests__/enterprise/with-cron-lock.test.ts; here it
// would only stand between the test and the logic under test.
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
}));

import prisma from "../../lib/prisma";
import { reverseCreditsForPayment } from "../../lib/referrals/service";
import { cleanupAbandonedPayments } from "../../scripts/payments/cleanup-abandoned-payments";

const db = prisma as unknown as {
  appointment: { findMany: jest.Mock };
  __tx: {
    payment: { findUnique: jest.Mock; update: jest.Mock };
    slotOfAppointment: {
      count: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    consultation: { delete: jest.Mock };
    subscription: { delete: jest.Mock };
  };
};
const tx = db.__tx;
const mockReverse = reverseCreditsForPayment as jest.Mock;

/** One abandoned consultation with a single PENDING Razorpay payment. */
function abandonedConsultation() {
  return {
    id: "apt_1",
    payment: [
      {
        id: "pay_1",
        userId: "user_1",
        paymentIntent: "order_abc",
        paymentGateway: "RAZORPAY",
        paymentStatus: "PENDING",
      },
    ],
    consultation: { id: "cons_1" },
    subscription: null,
    webinar: null,
    class: null,
    slotsOfAppointment: [{ id: "slot_1", isTentative: true }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;

  db.appointment.findMany.mockResolvedValue([abandonedConsultation()]);
  tx.payment.findUnique.mockResolvedValue({
    id: "pay_1",
    paymentStatus: "PENDING",
  });
  tx.payment.update.mockResolvedValue({});
  tx.slotOfAppointment.count.mockResolvedValue(0);
  tx.slotOfAppointment.deleteMany.mockImplementation(() => {
    order.push("deleteSlots");
    return Promise.resolve({ count: 1 });
  });
  tx.slotOfAppointment.findMany.mockResolvedValue([]);
  tx.slotOfAppointment.update.mockResolvedValue({});
  tx.consultation.delete.mockImplementation(() => {
    order.push("deleteConsultation");
    return Promise.resolve({});
  });
  tx.subscription.delete.mockResolvedValue({});
  mockReverse.mockImplementation(() => {
    order.push("reverseCredits");
    return Promise.resolve(500);
  });

  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("cleanupAbandonedPayments — referral credit reversal (#1169)", () => {
  it("restores credits for every pending payment it expires", async () => {
    const result = await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledTimes(1);
    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(result.cleanedCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it("restores the credits BEFORE the cascade delete removes the usage rows", async () => {
    await cleanupAbandonedPayments();

    expect(order).toEqual([
      "reverseCredits",
      "deleteSlots",
      "deleteConsultation",
    ]);
  });

  it("reverses inside the sweep transaction, not on the base client", async () => {
    await cleanupAbandonedPayments();

    // Passing the base client would leave the refund committed while the
    // delete rolled back — the corruption this reversal exists to prevent.
    const [, handle] = mockReverse.mock.calls[0];
    expect(handle).toBe(tx);
    expect(handle).not.toBe(prisma);
  });

  it("marks the payment EXPIRED rather than FAILED", async () => {
    await cleanupAbandonedPayments();

    // EXPIRED says "we timed this out"; FAILED would claim the gateway
    // rejected a charge that was never attempted.
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: { paymentStatus: "EXPIRED" },
    });
  });

  it("touches nothing when the payment succeeded mid-sweep", async () => {
    tx.payment.findUnique.mockResolvedValue({
      id: "pay_1",
      paymentStatus: "SUCCEEDED",
    });

    const result = await cleanupAbandonedPayments();

    expect(mockReverse).not.toHaveBeenCalled();
    expect(tx.consultation.delete).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
  });

  it("still frees the slot when the credit reversal fails", async () => {
    mockReverse.mockRejectedValue(new Error("credit ledger unavailable"));

    const result = await cleanupAbandonedPayments();

    // A stuck credit is a support ticket; a slot held open forever is lost
    // revenue for the consultant and a booking the consultee cannot make.
    expect(tx.consultation.delete).toHaveBeenCalled();
    expect(result.cleanedCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it("keeps a confirmed appointment, and still returns its credits", async () => {
    tx.slotOfAppointment.count.mockResolvedValue(1);

    await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(tx.consultation.delete).not.toHaveBeenCalled();
    // Only the unconfirmed holds are released.
    expect(tx.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: { appointmentId: "apt_1", isTentative: true },
    });
  });
});
