/**
 * @jest-environment node
 */

/**
 * #1583 A-P0-06 / #1589 T-P1-02 — the trial pay-link persist is a CAS that
 * reports rather than throws when the trial moved under it, and the re-mint
 * reuses a live PENDING intent on the held appointment instead of minting a
 * second gateway order.
 */

const reportSentryMessage = jest.fn();
const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryMessage: (...a: unknown[]) => reportSentryMessage(...a),
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
}));

const createApprovalPaymentIntent = jest.fn();
jest.mock("../../lib/payments/operations/approval-payment", () => ({
  __esModule: true,
  createApprovalPaymentIntent: (...a: unknown[]) =>
    createApprovalPaymentIntent(...a),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    trial: { updateMany: jest.fn() },
    payment: { findFirst: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import {
  persistTrialPayLink,
  remintTrialPayLink,
} from "../../lib/trials/pay-link";

const db = prisma as unknown as {
  trial: { updateMany: jest.Mock };
  payment: { findFirst: jest.Mock };
};

const IN_AN_HOUR = new Date(Date.now() + 60 * 60 * 1000);

function awaitingTrial() {
  return {
    id: "trial-1",
    status: "AWAITING_PAYMENT" as const,
    pendingPaymentUrl: null,
    paymentDueAt: IN_AN_HOUR,
    subscriptionPlanId: "plan-1",
    consulteeProfile: { userId: "user-1" },
    appointment: {
      id: "appt-1",
      occurrences: [{ startsAt: IN_AN_HOUR, endsAt: IN_AN_HOUR }],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.trial.updateMany.mockResolvedValue({ count: 1 });
  db.payment.findFirst.mockResolvedValue(null);
});

describe("persistTrialPayLink", () => {
  it("writes only onto an AWAITING_PAYMENT trial with no link, and reports a lost race", async () => {
    db.trial.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      persistTrialPayLink({
        trialId: "trial-1",
        paymentIntentId: "order_1",
        checkoutUrl: "order_1",
      }),
    ).resolves.toBe(false);

    expect(db.trial.updateMany).toHaveBeenCalledWith({
      where: {
        id: "trial-1",
        status: "AWAITING_PAYMENT",
        pendingPaymentUrl: null,
      },
      data: { pendingPaymentUrl: "order_1" },
    });
    expect(reportSentryMessage).toHaveBeenCalledWith(
      "PAY_LINK_ORPHANED",
      expect.objectContaining({
        expected: true,
        extra: { trialId: "trial-1", paymentIntentId: "order_1" },
      }),
    );
  });
});

describe("remintTrialPayLink", () => {
  it("reuses a live PENDING intent on the held appointment instead of minting again", async () => {
    db.payment.findFirst.mockResolvedValueOnce({
      id: "pay-1",
      paymentIntent: "order_live",
    });

    await expect(remintTrialPayLink(awaitingTrial())).resolves.toBe(
      "order_live",
    );

    expect(createApprovalPaymentIntent).not.toHaveBeenCalled();
    expect(db.trial.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pendingPaymentUrl: "order_live" } }),
    );
  });

  it("mints a new intent only when no live one exists", async () => {
    createApprovalPaymentIntent.mockResolvedValueOnce({
      paymentIntentId: "order_new",
      checkoutUrl: "order_new",
    });

    await expect(remintTrialPayLink(awaitingTrial())).resolves.toBe(
      "order_new",
    );

    expect(createApprovalPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentType: "TRIAL",
        trialId: "trial-1",
        appointmentId: "appt-1",
      }),
    );
  });

  it("leaves a trial past its pay window alone", async () => {
    const lapsed = { ...awaitingTrial(), paymentDueAt: new Date(0) };

    await expect(remintTrialPayLink(lapsed)).resolves.toBeNull();

    expect(db.payment.findFirst).not.toHaveBeenCalled();
    expect(createApprovalPaymentIntent).not.toHaveBeenCalled();
  });
});
