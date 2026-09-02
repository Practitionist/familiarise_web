/**
 * @jest-environment node
 */

/**
 * #1169 / #1319 — the abandoned-payment sweeper.
 *
 * The sweep used to DELETE the request, which cascaded the Appointment and
 * every Payment under it (#1074 class). It now soft-cancels: the request moves
 * to EXPIRED through the CAS helper, the slots are tombstoned by status, and
 * the money rows stay readable. Two things are pinned here: no delete member
 * exists on the mock (a surviving delete path throws a TypeError rather than
 * passing), and the referral-credit reversal still runs before the rows are
 * expired, inside the same transaction.
 */

const order: string[] = [];

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: { findUnique: jest.fn(), update: jest.fn() },
    slotOfAppointment: {
      count: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    appointment: { updateMany: jest.fn() },
    consultation: { updateMany: jest.fn() },
    subscription: { updateMany: jest.fn() },
  };
  const client = {
    ...tx,
    appointment: { findMany: jest.fn(), updateMany: tx.appointment.updateMany },
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
import { REQUEST_ALLOWED_FROM } from "../../lib/booking/transitions";

const db = prisma as unknown as {
  appointment: { findMany: jest.Mock };
  __tx: {
    payment: { findUnique: jest.Mock; update: jest.Mock };
    slotOfAppointment: {
      count: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    appointment: { updateMany: jest.Mock };
    consultation: { updateMany: jest.Mock };
    subscription: { updateMany: jest.Mock };
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
  tx.slotOfAppointment.updateMany.mockImplementation(() => {
    order.push("cancelSlots");
    return Promise.resolve({ count: 1 });
  });
  tx.slotOfAppointment.findMany.mockResolvedValue([]);
  tx.slotOfAppointment.update.mockResolvedValue({});
  tx.appointment.updateMany.mockImplementation(() => {
    order.push("tombstoneAppointment");
    return Promise.resolve({ count: 1 });
  });
  tx.consultation.updateMany.mockImplementation(() => {
    order.push("expireConsultation");
    return Promise.resolve({ count: 1 });
  });
  tx.subscription.updateMany.mockResolvedValue({ count: 1 });
  mockReverse.mockImplementation(() => {
    order.push("reverseCredits");
    return Promise.resolve(500);
  });

  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("cleanupAbandonedPayments — soft-cancel + credit reversal (#1319)", () => {
  it("restores credits for every pending payment it expires", async () => {
    const result = await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledTimes(1);
    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(result.cleanedCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it("never deletes: the request is EXPIRED through the CAS, slots and appointment are tombstoned", async () => {
    await cleanupAbandonedPayments();

    expect(tx.consultation.updateMany).toHaveBeenCalledWith({
      where: { id: "cons_1", status: { in: REQUEST_ALLOWED_FROM.EXPIRED } },
      data: { status: "EXPIRED" },
    });
    expect(tx.slotOfAppointment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: "apt_1",
          deletedAt: null,
        }),
        data: expect.objectContaining({
          completionStatus: "CANCELLED",
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "apt_1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("reverses credits before the rows are expired, inside the transaction", async () => {
    await cleanupAbandonedPayments();

    expect(order).toEqual([
      "reverseCredits",
      "expireConsultation",
      "cancelSlots",
      "tombstoneAppointment",
    ]);
    const [, handle] = mockReverse.mock.calls[0];
    expect(handle).toBe(tx);
    expect(handle).not.toBe(prisma);
  });

  it("marks the payment EXPIRED rather than FAILED", async () => {
    await cleanupAbandonedPayments();

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
    expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
  });

  it("skips the row, without an error, when the CAS finds it already moved on", async () => {
    // A capture or an approval landed between the cohort read and the write.
    tx.consultation.updateMany.mockResolvedValue({ count: 0 });

    const result = await cleanupAbandonedPayments();

    expect(tx.slotOfAppointment.updateMany).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
  });

  it("still frees the slot when the credit reversal fails", async () => {
    mockReverse.mockRejectedValue(new Error("credit ledger unavailable"));

    const result = await cleanupAbandonedPayments();

    expect(tx.consultation.updateMany).toHaveBeenCalled();
    expect(result.cleanedCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it("keeps a confirmed appointment, releases only the tentative holds, and still returns its credits", async () => {
    tx.slotOfAppointment.count.mockResolvedValue(1);

    await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(tx.slotOfAppointment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: "apt_1",
          isTentative: true,
          deletedAt: null,
        }),
        data: expect.objectContaining({ completionStatus: "CANCELLED" }),
      }),
    );
  });
});
