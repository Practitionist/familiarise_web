/**
 * @jest-environment node
 */

/**
 * #1591 J4-P0-03 / #1583 A-P1-05 — an unpaid trial the sweep cancels also
 * tombstones its held appointment and cancels its seats, riding the same
 * CAS win; a lost CAS (paid or scheduled in between) touches nothing.
 */

const softCancelTrialAppointment = jest.fn();
jest.mock("../../lib/trials/cancellation", () => ({
  softCancelTrialAppointment: (...a: unknown[]) =>
    softCancelTrialAppointment(...a),
}));
const notifyTrialCancelled = jest.fn();
jest.mock("../../lib/novu/service", () => ({
  notifyTrialCancelled: (...a: unknown[]) => notifyTrialCancelled(...a),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
}));
const stageTrialRefundedBell = jest.fn();
jest.mock("../../lib/trials/refund-bell", () => ({
  stageTrialRefundedBell: (...a: unknown[]) => stageTrialRefundedBell(...a),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => {
  const tx = {
    trial: { findUnique: jest.fn(), updateMany: jest.fn() },
    bookingStatusHistory: { create: jest.fn() },
  };
  return {
    __esModule: true,
    default: {
      trial: { findMany: jest.fn() },
      $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

import prisma from "../../lib/prisma";
import { expireUnpaidTrials } from "../../scripts/trials/expire-unpaid-trials";

const db = prisma as unknown as {
  trial: { findMany: jest.Mock };
  __tx: {
    trial: { findUnique: jest.Mock; updateMany: jest.Mock };
    bookingStatusHistory: { create: jest.Mock };
  };
};

const lapsed = {
  id: "trial-1",
  appointmentId: "appt-1",
  consulteeProfile: { user: { id: "u1", name: "Sam" } },
  subscriptionPlan: {
    title: "Plan",
    consultantProfile: { user: { name: "Olivia" } },
  },
  appointment: { occurrences: [{ startsAt: new Date("2030-01-01T10:00Z") }] },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  db.trial.findMany.mockResolvedValueOnce([lapsed]).mockResolvedValue([]);
  db.__tx.trial.findUnique.mockResolvedValue({
    status: "AWAITING_PAYMENT",
    appointment: { id: "appt-1" },
  });
  db.__tx.bookingStatusHistory.create.mockResolvedValue({});
  notifyTrialCancelled.mockResolvedValue({ success: true });
});
afterEach(() => jest.restoreAllMocks());

describe("expire-unpaid-trials tombstones the held call", () => {
  it("soft-cancels the appointment and notifies after the CAS win", async () => {
    db.__tx.trial.updateMany.mockResolvedValue({ count: 1 });

    const result = await expireUnpaidTrials();

    expect(result.trialsExpired).toBe(1);
    expect(softCancelTrialAppointment).toHaveBeenCalledWith("appt-1");
    // After the CAS transaction, never inside it.
    expect(
      softCancelTrialAppointment.mock.invocationCallOrder[0],
    ).toBeGreaterThan(db.__tx.trial.updateMany.mock.invocationCallOrder[0]);
    expect(notifyTrialCancelled).toHaveBeenCalledWith(
      ["u1"],
      expect.objectContaining({ status: "CANCELLED", planTitle: "Plan" }),
    );
  });

  it("isolates a failed tombstone and re-tombstones it from the repair cohort next run", async () => {
    db.__tx.trial.updateMany.mockResolvedValue({ count: 1 });
    softCancelTrialAppointment.mockRejectedValueOnce(new Error("pool busy"));

    const first = await expireUnpaidTrials();
    expect(first.success).toBe(true);
    expect(first.trialsExpired).toBe(1);

    // Next run: the AWAITING_PAYMENT cohort is empty, the repair cohort sees
    // the CANCELLED trial whose appointment still has deletedAt null.
    db.trial.findMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "trial-1", appointmentId: "appt-1" }]);
    softCancelTrialAppointment.mockResolvedValueOnce(undefined);

    await expireUnpaidTrials();
    expect(softCancelTrialAppointment).toHaveBeenLastCalledWith("appt-1");
    expect(db.trial.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "CANCELLED", appointment: { deletedAt: null } },
      }),
    );
  });

  it("touches nothing when the trial was paid or scheduled in between", async () => {
    db.__tx.trial.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireUnpaidTrials();

    expect(result.trialsExpired).toBe(0);
    expect(softCancelTrialAppointment).not.toHaveBeenCalled();
    expect(notifyTrialCancelled).not.toHaveBeenCalled();
  });
});

// #1775 C-12 — the unpaid lapse arm never touches a captured trial; a paid
// trial nobody answered in 48 h is cancelled and refunded in full.
describe("paid trials charged at request", () => {
  it("(i) the lapse cohort and its CAS require paymentId null", async () => {
    db.__tx.trial.updateMany.mockResolvedValue({ count: 1 });
    await expireUnpaidTrials();
    const cohort = db.trial.findMany.mock.calls[0][0].where;
    expect(cohort.paymentId).toBeNull();
    const cas = db.__tx.trial.updateMany.mock.calls[0][0].where;
    expect(cas.AND[0].paymentId).toBeNull();
    expect(cas.status).toEqual({ in: ["AWAITING_PAYMENT", "PENDING"] });
  });

  it("(ii) a paid trial unanswered for 49 h is cancelled from PENDING and refunded in full", async () => {
    db.trial.findMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...lapsed,
          paymentId: "pay-1",
          consultantProfile: { user: { id: "u2" } },
        },
      ]);
    db.__tx.trial.updateMany.mockResolvedValue({ count: 1 });
    refundBookingPayment.mockResolvedValue({ amountRefundedPaise: 50_000 });

    const result = await expireUnpaidTrials();

    const cas = db.__tx.trial.updateMany.mock.calls[0][0].where;
    expect(cas.status).toEqual({ in: ["PENDING"] });
    expect(cas.AND[0].paymentId).toEqual({ not: null });
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment.mock.calls[0][0]).not.toHaveProperty(
      "amountPaise",
    );
    expect(stageTrialRefundedBell).toHaveBeenCalledTimes(1);
    expect(result.trialsUnansweredRefunded).toBe(1);
  });
});
