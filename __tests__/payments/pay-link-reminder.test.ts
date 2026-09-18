/**
 * @jest-environment node
 */

/**
 * #1703 D2 — the 24 h pay-link and its half-window reminder, both passes of
 * `scripts/payments/cleanup-abandoned-payments.ts`:
 *   - the reminder fires once (the FailedEmail row it staged is the guard),
 *     never after payment, never after expiry;
 *   - the 24 h expiry tells the consultee the link lapsed.
 * The 48 h PENDING expiry's notice is pinned beside its sweep in
 * request-hold-hygiene.test.ts.
 */

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: { findUnique: jest.fn(), updateMany: jest.fn() },
    appointmentOccurrence: {
      updateManyAndReturn: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    consultation: { findUnique: jest.fn(), updateMany: jest.fn() },
    bookingStatusHistory: { create: jest.fn() },
  };
  const client = {
    ...tx,
    consultation: { ...tx.consultation, findMany: jest.fn() },
    subscription: { findMany: jest.fn() },
    failedEmail: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  cancelRazorpayOrder: jest.fn(),
}));
jest.mock("../../lib/payments/core/stripe", () => ({
  __esModule: true,
  getStripeClient: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
}));
const mockSendPaymentLinkEmail = jest.fn();
jest.mock("../../lib/email", () => ({
  PAYMENT_LINK_REMINDER_EMAIL_TYPE: "PAYMENT_LINK_REMINDER",
  sendPaymentLinkEmail: (...a: unknown[]) =>
    mockSendPaymentLinkEmail(...(a as [])),
}));
const mockNotifyExpired = jest.fn();
jest.mock("../../lib/booking/expiry-notices", () => ({
  PAY_LINK_LAPSED_REASON: "lapsed",
  notifyConsulteeRequestExpired: (...a: unknown[]) =>
    mockNotifyExpired(...(a as [])),
}));

import prisma from "../../lib/prisma";
import {
  cleanupExpiredApprovalPendingPayments,
  remindApprovalPaymentsDue,
} from "../../scripts/payments/cleanup-abandoned-payments";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "../../lib/payments/constants";

const db = prisma as unknown as {
  consultation: { findMany: jest.Mock };
  subscription: { findMany: jest.Mock };
  failedEmail: { findMany: jest.Mock };
  __tx: {
    payment: { findUnique: jest.Mock; updateMany: jest.Mock };
    appointmentOccurrence: {
      updateManyAndReturn: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    consultation: { findUnique: jest.Mock; updateMany: jest.Mock };
    bookingStatusHistory: { create: jest.Mock };
  };
};
const tx = db.__tx;

const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000);
const consultee = { id: "u_consultee", name: "Sam", email: "sam@x.test" };
const consultantUser = { user: { name: "Olivia" } };

function reminderCandidate() {
  return {
    id: "cons_1",
    pendingPaymentUrl: "https://pay/1",
    requestedBy: { user: consultee },
    consultationPlan: { consultantProfile: consultantUser },
    appointment: {
      payment: [
        { id: "pay_1", amount: 5000, currency: "INR", expiresAt: inSixHours },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  db.subscription.findMany.mockResolvedValue([]);
  db.failedEmail.findMany.mockResolvedValue([]);
  tx.payment.findUnique.mockResolvedValue({
    paymentStatus: "PENDING",
    expiresAt: inSixHours,
  });
  mockSendPaymentLinkEmail.mockResolvedValue({ success: true });
});
afterEach(() => jest.restoreAllMocks());

describe("pay-link window", () => {
  it("is 24 hours", () => {
    expect(APPROVAL_PAYMENT_EXPIRATION_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("remindApprovalPaymentsDue", () => {
  it("sends the reminder variant once, keyed on the payment", async () => {
    db.consultation.findMany.mockResolvedValue([reminderCandidate()]);
    const first = await remindApprovalPaymentsDue();
    expect(first.cleanedCount).toBe(1);
    expect(mockSendPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "sam@x.test",
        paymentId: "pay_1",
        reminder: true,
        expiresAt: inSixHours,
      }),
    );

    // The staged row is the guard: the next run finds it and stays quiet.
    db.failedEmail.findMany.mockResolvedValue([{ entityRef: "payment:pay_1" }]);
    const second = await remindApprovalPaymentsDue();
    expect(second.skippedCount).toBe(1);
    expect(mockSendPaymentLinkEmail).toHaveBeenCalledTimes(1);
  });

  it("never reminds after payment or after expiry", async () => {
    db.consultation.findMany.mockResolvedValue([reminderCandidate()]);
    tx.payment.findUnique.mockResolvedValueOnce({
      paymentStatus: "SUCCEEDED",
      expiresAt: inSixHours,
    });
    await remindApprovalPaymentsDue();
    tx.payment.findUnique.mockResolvedValueOnce({
      paymentStatus: "PENDING",
      expiresAt: new Date(Date.now() - 1000),
    });
    await remindApprovalPaymentsDue();
    expect(mockSendPaymentLinkEmail).not.toHaveBeenCalled();
  });
});

describe("the 24 h expiry tells the consultee", () => {
  it("notifies once the lapsed request has committed as EXPIRED", async () => {
    db.consultation.findMany.mockResolvedValue([
      {
        id: "cons_1",
        requestedBy: { user: consultee },
        consultationPlan: { title: "Plan", consultantProfile: consultantUser },
        appointment: {
          id: "apt_1",
          organizationId: null,
          payment: [{ id: "pay_1" }],
          occurrences: [{ startsAt: inSixHours }],
        },
      },
    ]);
    tx.consultation.findUnique.mockResolvedValue({
      status: "APPROVED_PENDING_PAYMENT",
      appointment: { id: "apt_1", organizationId: null },
    });
    tx.consultation.updateMany.mockResolvedValue({ count: 1 });
    tx.bookingStatusHistory.create.mockResolvedValue({});
    tx.appointmentOccurrence.findMany.mockResolvedValue([]);
    tx.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([]);
    tx.payment.updateMany.mockResolvedValue({ count: 1 });

    const result = await cleanupExpiredApprovalPendingPayments();
    expect(result.cleanedCount).toBe(1);
    expect(mockNotifyExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: "apt_1",
        consulteeUserId: "u_consultee",
        appointmentType: "CONSULTATION",
        reason: "lapsed",
      }),
    );
  });
});
