/**
 * @jest-environment node
 */

/**
 * #1686 — two ticker targets failed on every tick for weeks because they
 * treated a permanent state as retryable. `reconcile-payment-status` answered
 * 500 for a gateway reference the gateway will never know, and
 * `reconcile-orphaned-confirmations` re-drove the same Stream calls for pairs
 * the #1188 DM gate refuses. Both now dead-letter that state (a CAS write that
 * moves the row out of the sweep's predicate) and keep reporting a transient
 * failure as one.
 */

import { DmNotPermittedError } from "@/lib/stream/dm-eligibility";

const mockRetrieve = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: class {
    paymentIntents = { retrieve: mockRetrieve };
    checkout = { sessions: { retrieve: jest.fn() } };
  },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), updateMany: jest.fn() },
    appointment: { findMany: jest.fn(), updateMany: jest.fn() },
    appointmentOccurrence: { count: jest.fn() },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_k: string, _o: unknown, fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  confirmExistingAppointment: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/ensure-channels", () => ({
  ensureChannelsForAppointment: jest.fn(),
}));
// The gate's module pulls in Prisma; only the error class is needed here.
jest.mock("../../lib/stream/dm-eligibility", () => ({
  DmNotPermittedError: class extends Error {
    constructor() {
      super(
        "Direct messages are only available between people who share a booking.",
      );
      this.name = "DmNotPermittedError";
    }
  },
}));

import prisma from "@/lib/prisma";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";
import { reconcileOrphanedConfirmations } from "@/scripts/payments/reconcile-orphaned-confirmations";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";

const db = prisma as unknown as {
  payment: { findMany: jest.Mock; updateMany: jest.Mock };
  appointment: { findMany: jest.Mock; updateMany: jest.Mock };
};
const mockEnsure = ensureChannelsForAppointment as jest.Mock;

const stripeRow = {
  id: "pay_seed",
  paymentGateway: "STRIPE",
  paymentStatus: "PENDING",
  paymentIntent: "103e6474-6cc3-4d37-9673-25af4b1dd566",
  createdAt: new Date(Date.now() - 60 * 60_000),
  user: { name: "Seed" },
  appointment: null,
};
const razorpayRow = {
  ...stripeRow,
  id: "pay_rzp",
  paymentGateway: "RAZORPAY",
  paymentIntent: "order_unknown",
};

describe("reconcile-payment-status dead-letters an unknown gateway reference", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.RAZORPAY_SECRET = "secret";
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    db.payment.updateMany.mockResolvedValue({ count: 1 });
  });

  it("Stripe resource_missing → EXPIRED via CAS on PENDING, no error", async () => {
    db.payment.findMany.mockResolvedValue([stripeRow]);
    mockRetrieve.mockRejectedValue(
      Object.assign(new Error("No such payment_intent: '103e…'"), {
        code: "resource_missing",
      }),
    );

    const result = await reconcilePaymentStatus();

    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_seed", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(result.deadLetteredCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("Razorpay 400 BAD_REQUEST_ERROR → EXPIRED; a 5xx stays an error with the row untouched", async () => {
    db.payment.findMany.mockResolvedValue([razorpayRow]);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "BAD_REQUEST_ERROR" } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const unknown = await reconcilePaymentStatus();
    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_rzp", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(unknown.deadLetteredCount).toBe(1);
    expect(unknown.errors).toEqual([]);

    jest.clearAllMocks();
    db.payment.findMany.mockResolvedValue([razorpayRow]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const transient = await reconcilePaymentStatus();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(transient.deadLetteredCount).toBe(0);
    expect(transient.errors).toHaveLength(1);
    expect(transient.success).toBe(false);
  });
});

describe("reconcile-orphaned-confirmations dead-letters a DM the gate refuses", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    db.payment.findMany.mockResolvedValue([]);
    db.appointment.findMany.mockResolvedValue([
      { id: "appt-1", _count: { payment: 1 } },
    ]);
    db.appointment.updateMany.mockResolvedValue({ count: 1 });
  });

  it("DmNotPermittedError → stamped out of the queue; a transient throw leaves the row", async () => {
    mockEnsure.mockRejectedValue(new DmNotPermittedError("a", "b"));

    const permanent = await reconcileOrphanedConfirmations();
    expect(db.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "appt-1", chatChannelEnsuredAt: null },
      data: { chatChannelEnsuredAt: expect.any(Date) },
    });
    expect(permanent.channelsDeadLettered).toBe(1);
    expect(permanent.channelsFailed).toBe(0);

    jest.clearAllMocks();
    db.payment.findMany.mockResolvedValue([]);
    db.appointment.findMany.mockResolvedValue([
      { id: "appt-1", _count: { payment: 1 } },
    ]);
    mockEnsure.mockRejectedValue(new Error("Stream 503"));

    const transient = await reconcileOrphanedConfirmations();
    expect(db.appointment.updateMany).not.toHaveBeenCalled();
    expect(transient.channelsDeadLettered).toBe(0);
    expect(transient.channelsFailed).toBe(1);
  });
});
