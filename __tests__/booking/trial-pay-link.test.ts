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
    trial: { updateMany: jest.fn(), findUnique: jest.fn() },
    payment: { findFirst: jest.fn(), updateMany: jest.fn() },
  },
}));

// The re-mint serialises on the appointment atom; a pass-through here.
const withAppointmentLock = jest.fn(
  async (_id: string, fn: () => Promise<unknown>) => fn(),
);
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: (...a: [string, () => Promise<unknown>]) =>
    withAppointmentLock(...a),
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
}));

import prisma from "../../lib/prisma";
import {
  persistTrialPayLink,
  remintTrialPayLink,
} from "../../lib/trials/pay-link";

const db = prisma as unknown as {
  trial: { updateMany: jest.Mock; findUnique: jest.Mock };
  payment: { findFirst: jest.Mock; updateMany: jest.Mock };
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
  withAppointmentLock.mockImplementation(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  );
  db.trial.updateMany.mockReset().mockResolvedValue({ count: 1 });
  db.trial.findUnique.mockReset();
  // The in-lock re-read: still waiting, no link, window open.
  db.trial.findUnique.mockResolvedValue({
    status: "AWAITING_PAYMENT",
    pendingPaymentUrl: null,
    paymentDueAt: IN_AN_HOUR,
  });
  db.payment.findFirst.mockResolvedValue(null);
  db.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe("persistTrialPayLink", () => {
  it("writes only onto a payable, uncaptured trial with no link (#1775 C-7)", async () => {
    await expect(
      persistTrialPayLink({
        trialId: "trial-1",
        paymentIntentId: "order_1",
        paymentId: "pay_1",
        checkoutUrl: "order_1",
      }),
    ).resolves.toBe("/checkout/pay/pay_1");

    // #1775 P-1 — the stored link is our pay page, never the bare order id.
    expect(db.trial.updateMany).toHaveBeenCalledWith({
      where: {
        id: "trial-1",
        status: { in: ["PENDING", "AWAITING_PAYMENT"] },
        paymentId: null,
        pendingPaymentUrl: null,
      },
      data: { pendingPaymentUrl: "/checkout/pay/pay_1" },
    });
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });

  it("on a lost race against the sweep: tombstones the order, reports, and returns null", async () => {
    db.trial.updateMany.mockResolvedValueOnce({ count: 0 });
    db.trial.findUnique.mockResolvedValueOnce({
      status: "CANCELLED",
      pendingPaymentUrl: null,
    });

    await expect(
      persistTrialPayLink({
        trialId: "trial-1",
        paymentIntentId: "order_1",
        paymentId: "pay_1",
        checkoutUrl: "order_1",
      }),
    ).resolves.toBeNull();

    // #1695 shape: the mint's own PENDING row flips to EXPIRED, expiresAt now.
    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { paymentIntent: "order_1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED", expiresAt: expect.any(Date) },
    });
    expect(reportSentryMessage).toHaveBeenCalledWith(
      "PAY_LINK_ORPHANED",
      expect.objectContaining({
        expected: true,
        extra: expect.objectContaining({
          trialId: "trial-1",
          paymentIntentId: "order_1",
        }),
      }),
    );
  });

  it("on a lost race against a sibling mint of the same order: nothing is orphaned", async () => {
    db.trial.updateMany.mockResolvedValueOnce({ count: 0 });
    db.trial.findUnique.mockResolvedValueOnce({
      status: "AWAITING_PAYMENT",
      pendingPaymentUrl: "/checkout/pay/pay_1",
    });

    await expect(
      persistTrialPayLink({
        trialId: "trial-1",
        paymentIntentId: "order_1",
        paymentId: "pay_1",
        checkoutUrl: "order_1",
      }),
    ).resolves.toBe("/checkout/pay/pay_1");

    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
  });
});

describe("remintTrialPayLink", () => {
  it("reuses a live PENDING intent on the held appointment instead of minting again", async () => {
    db.payment.findFirst.mockResolvedValueOnce({
      id: "pay-1",
      paymentIntent: "order_live",
    });

    await expect(remintTrialPayLink(awaitingTrial())).resolves.toBe(
      "/checkout/pay/pay-1",
    );

    expect(createApprovalPaymentIntent).not.toHaveBeenCalled();
    expect(db.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentGateway: "RAZORPAY" }),
      }),
    );
    expect(db.trial.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { pendingPaymentUrl: "/checkout/pay/pay-1" },
      }),
    );
  });

  it("returns the link a sibling read minted moments earlier instead of minting again", async () => {
    db.trial.findUnique.mockResolvedValueOnce({
      status: "AWAITING_PAYMENT",
      pendingPaymentUrl: "order_sibling",
      paymentDueAt: IN_AN_HOUR,
    });

    await expect(remintTrialPayLink(awaitingTrial())).resolves.toBe(
      "order_sibling",
    );

    expect(db.payment.findFirst).not.toHaveBeenCalled();
    expect(createApprovalPaymentIntent).not.toHaveBeenCalled();
  });

  it("mints a new intent only when no live one exists", async () => {
    createApprovalPaymentIntent.mockResolvedValueOnce({
      paymentIntentId: "order_new",
      paymentId: "pay_new",
      checkoutUrl: "order_new",
    });

    await expect(remintTrialPayLink(awaitingTrial())).resolves.toBe(
      "/checkout/pay/pay_new",
    );

    expect(createApprovalPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentType: "TRIAL",
        trialId: "trial-1",
        appointmentId: "appt-1",
      }),
    );
  });

  it("does not reuse an expired PENDING intent: it mints one replacement", async () => {
    // The lookup itself excludes expired rows (expiresAt <= now), so an
    // expired intent is invisible here and exactly one new order is minted.
    db.payment.findFirst.mockResolvedValueOnce(null);
    createApprovalPaymentIntent.mockResolvedValueOnce({
      paymentIntentId: "order_fresh",
      paymentId: "pay_fresh",
      checkoutUrl: "order_fresh",
    });

    await expect(remintTrialPayLink(awaitingTrial())).resolves.toBe(
      "/checkout/pay/pay_fresh",
    );

    expect(db.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentStatus: "PENDING",
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
    expect(createApprovalPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("two concurrent reads mint once and both receive the same link", async () => {
    // The appointment atom serialises the two callers; the second one's
    // in-lock re-read sees the link the first persisted.
    let inFlight: Promise<unknown> | null = null;
    withAppointmentLock.mockImplementation(
      async (_id: string, fn: () => Promise<unknown>) => {
        while (inFlight) await inFlight;
        inFlight = fn();
        try {
          return await inFlight;
        } finally {
          inFlight = null;
        }
      },
    );
    let stored: string | null = null;
    db.trial.findUnique.mockImplementation(async () => ({
      status: "AWAITING_PAYMENT",
      pendingPaymentUrl: stored,
      paymentDueAt: IN_AN_HOUR,
    }));
    db.trial.updateMany.mockImplementation(async ({ data }) => {
      if (stored) return { count: 0 };
      stored = data.pendingPaymentUrl;
      return { count: 1 };
    });
    createApprovalPaymentIntent.mockResolvedValue({
      paymentIntentId: "order_once",
      checkoutUrl: "order_once",
    });

    const [a, b] = await Promise.all([
      remintTrialPayLink(awaitingTrial()),
      remintTrialPayLink(awaitingTrial()),
    ]);

    expect(a).toBe("order_once");
    expect(b).toBe("order_once");
    expect(createApprovalPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("leaves a trial past its pay window alone", async () => {
    const lapsed = { ...awaitingTrial(), paymentDueAt: new Date(0) };

    await expect(remintTrialPayLink(lapsed)).resolves.toBeNull();

    expect(db.payment.findFirst).not.toHaveBeenCalled();
    expect(createApprovalPaymentIntent).not.toHaveBeenCalled();
  });
});
