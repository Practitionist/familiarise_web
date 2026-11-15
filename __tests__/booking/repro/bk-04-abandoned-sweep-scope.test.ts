/**
 * @jest-environment node
 */

// Invariant: the abandoned sweep touches only lapsed PENDING payments and releases only HELD seats of those payers.

type Row = Record<string, unknown>;

// Minimal Prisma-where evaluator for the filters these fixtures need.
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    if (key === "NOT") return !matches(row, cond as Row);
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date || typeof cond !== "object") return value === cond;
    const c = cond as { in?: unknown[]; lt?: Date; not?: unknown };
    if (c.in) return c.in.includes(value);
    if (c.lt) return value instanceof Date && value.getTime() < c.lt.getTime();
    if ("not" in c) return value !== c.not;
    return true;
  });
}

const LAPSED = new Date(Date.now() - 60 * 60 * 1000);
const LIVE_HOLD = new Date(Date.now() + 20 * 60 * 1000);

const payments: Row[] = [];
const participants: Row[] = [];
const cancelledIntents: string[] = [];

jest.mock("../../../lib/prisma", () => {
  const tx = {
    payment: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          payments.find((p) => p.id === where.id) ?? null,
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const hit = payments.filter((p) => matches(p, where));
          hit.forEach((p) => Object.assign(p, data));
          return { count: hit.length };
        },
      ),
    },
    appointmentParticipant: {
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const hit = participants.filter((p) => matches(p, where));
          hit.forEach((p) => Object.assign(p, data));
          return { count: hit.length };
        },
      ),
    },
    bookingUtilization: { findUnique: jest.fn(async () => null) },
  };
  return {
    __esModule: true,
    default: {
      appointment: {
        findMany: jest.fn(
          async (args: { include: { payment: { where: Row } } }) => [
            {
              id: "apt-w",
              deletedAt: null,
              consultation: null,
              subscription: null,
              webinar: { id: "web-1" },
              class: null,
              occurrences: [],
              payment: payments.filter((p) =>
                matches(p, args.include.payment.where),
              ),
            },
          ],
        ),
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  };
});
jest.mock("../../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(async () => 0),
}));
jest.mock("../../../lib/payments/core/razorpay", () => ({
  cancelRazorpayOrder: jest.fn(async (intent: string) => {
    cancelledIntents.push(intent);
    return "no_live_payment";
  }),
}));
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../../lib/booking/backup-interest", () => ({
  flushBackupInterestNotices: async () => undefined,
  stageNoticesForAppointmentHolds: async () => null,
}));
jest.mock("../../../lib/booking/expiry-notices", () => ({
  notifyConsulteeRequestExpired: jest.fn(),
  PAY_LINK_LAPSED_REASON: "lapsed",
}));
jest.mock("../../../lib/email", () => ({
  PAYMENT_LINK_REMINDER_EMAIL_TYPE: "x",
  sendPaymentLinkEmail: jest.fn(),
}));
jest.mock("../../../lib/novu/service", () => ({
  notifyPaymentLink: jest.fn(),
}));
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(),
}));
jest.mock("../../../lib/booking/lapse-approved-request", () => ({
  lapseApprovedRequest: jest.fn(),
}));

import { cleanupAbandonedPayments } from "../../../scripts/payments/cleanup-abandoned-payments";

const payment = (id: string, userId: string, expiresAt: Date): Row => ({
  id,
  userId,
  appointmentId: "apt-w",
  paymentIntent: `order_${id}`,
  paymentGateway: "RAZORPAY",
  paymentStatus: "PENDING",
  expiresAt,
  createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
});
const seat = (userId: string, status: string): Row => ({
  appointmentId: "apt-w",
  userId,
  role: "CONSULTEE",
  status,
});
const seatOf = (userId: string) =>
  participants.find((p) => p.userId === userId)?.status;
const payOf = (id: string) => payments.find((p) => p.id === id)?.paymentStatus;

beforeEach(() => {
  payments.length = 0;
  participants.length = 0;
  cancelledIntents.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("abandoned sweep on a shared webinar appointment", () => {
  it("leaves buyer B (hold still live) untouched while expiring buyer A", async () => {
    payments.push(
      payment("A", "user-a", LAPSED),
      payment("B", "user-b", LIVE_HOLD),
    );
    participants.push(seat("user-a", "HELD"), seat("user-b", "HELD"));

    await cleanupAbandonedPayments();

    expect(payOf("A")).toBe("EXPIRED");
    expect(seatOf("user-a")).toBe("CANCELLED");
    expect(cancelledIntents).toEqual(["order_A"]);
    expect(payOf("B")).toBe("PENDING");
    expect(seatOf("user-b")).toBe("HELD");
  });

  it("never releases a CONFIRMED seat", async () => {
    payments.push(payment("A", "user-a", LAPSED));
    participants.push(seat("user-a", "CONFIRMED"));

    await cleanupAbandonedPayments();

    expect(seatOf("user-a")).toBe("CONFIRMED");
  });
});
