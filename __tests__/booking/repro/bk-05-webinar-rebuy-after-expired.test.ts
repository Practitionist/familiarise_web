/**
 * @jest-environment node
 */

// Invariant: re-buying a webinar seat after an EXPIRED payment never 500s; the dead row is re-minted in place and its old order is tombstoned.

import "../../booking-algorithm/setup";
import { Prisma } from "@prisma/client";

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual("./checkout-harness/setup").db,
}));
jest.mock("../../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));
const createPaymentIntent = jest.fn();
jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: (...a: unknown[]) => createPaymentIntent(...a),
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("../../../utils/appointmentlock", () => ({
  __esModule: true,
  CHECKOUT_WAIT_RETRY_CONFIG: { retryCount: 5 },
  CHECKOUT_LOCK_TTL_MS: {},
  EventFullError: class extends Error {},
  lockSlotBooking: jest.fn(async () => ({ key: "k" })),
  unlockSlotBooking: jest.fn(),
  lockEventCheckout: jest.fn(async () => ({ key: "k" })),
  unlockEventCheckout: jest.fn(),
  lockConsulteeBooking: jest.fn(async () => ({ key: "k" })),
  unlockConsulteeBooking: jest.fn(),
  extendLock: jest.fn(async () => true),
  extendSlotInterval: jest.fn(async () => true),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  ensurePlatformCancellationPolicy: jest.fn(async () => undefined),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import { handleCheckout } from "../../../lib/payments/operations/checkout";
import { resetDouble } from "./checkout-harness/setup";
import type { CheckoutInput } from "../../../schemas/checkout";

type Row = Record<string, unknown>;
let payments: Row[] = [];

const APPT = "appt-webinar";
const BUYER = "buyer";
const OLD_INTENT = "order_OLD";

const webinar = {
  id: "web-1",
  status: "SCHEDULED",
  webinarPlan: {
    id: "wplan-1",
    price: 100_000,
    priceCurrency: "INR",
    maxParticipants: 50,
    refundWindowHours: 24,
    archivedAt: null,
    visibility: "PUBLIC",
    status: "PUBLISHED",
    organizationId: null,
    consultantProfileId: "cons-profile",
    consultantProfile: {
      id: "cons-profile",
      userId: "cons-user",
      deletedAt: null,
      verificationStatus: "VERIFIED",
    },
  },
  appointment: {
    id: APPT,
    occurrences: [
      {
        id: "occ-1",
        startsAt: new Date(Date.now() + 72 * 3600_000),
        endsAt: new Date(Date.now() + 73 * 3600_000),
        deletedAt: null,
        completionStatus: "SCHEDULED",
      },
    ],
    participants: [],
  },
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["userId", "appointmentId"] },
  });

const input = {
  appointmentType: "WEBINAR",
  planId: "wplan-1",
  eventId: "web-1",
  paymentGateway: "RAZORPAY",
} as unknown as CheckoutInput;

beforeEach(() => {
  payments = [
    {
      id: "pay-dead",
      userId: BUYER,
      appointmentId: APPT,
      paymentIntent: OLD_INTENT,
      paymentStatus: "EXPIRED",
    },
  ];
  createPaymentIntent.mockReset();
  createPaymentIntent.mockResolvedValue({
    id: "order_NEW",
    client_secret: "s",
  });
  resetDouble({
    "user.findUnique": () => ({
      id: BUYER,
      consulteeProfile: { id: "cp-buyer", billingStateCode: null },
    }),
    "webinar.findUnique": () => webinar,
    "webinarPlan.findUnique": () => ({
      consultantProfileId: "cons-profile",
      organizationId: null,
      collaborators: [],
    }),
    // Mirrors @@unique([userId, appointmentId]); NULL appointmentId never collides.
    "payment.create": (args) => {
      const data = (args as { data: Row }).data;
      const clash =
        data.appointmentId &&
        payments.some(
          (p) =>
            p.userId === data.userId && p.appointmentId === data.appointmentId,
        );
      if (clash) throw p2002();
      const row = { id: `pay-${payments.length}`, ...data };
      payments.push(row);
      return row;
    },
    "payment.findFirst": (args) => {
      const where = (args as { where?: Row }).where ?? {};
      return (
        payments.find(
          (p) =>
            (!where.userId || p.userId === where.userId) &&
            (!where.appointmentId || p.appointmentId === where.appointmentId),
        ) ?? null
      );
    },
    "payment.update": (args) => {
      const { where, data } = args as { where: { id: string }; data: Row };
      const row = payments.find((p) => p.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
    "payment.updateMany": (args) => {
      const { where, data } = args as { where: Row; data: Row };
      const hit = payments.filter(
        (p) =>
          (!where.id || p.id === where.id) &&
          (!where.userId || p.userId === where.userId),
      );
      hit.forEach((p) => Object.assign(p, data));
      return { count: hit.length };
    },
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const run = () =>
  handleCheckout(input, BUYER).then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  );

describe("re-buying a webinar seat after an EXPIRED payment on the same appointment", () => {
  it("never surfaces an unmapped error: success, or a typed 409", async () => {
    const { error } = await run();
    if (error === null) return;
    const typed = error as { httpStatus?: number; code?: string };
    expect(typed.httpStatus).toBe(409);
    expect(typeof typed.code).toBe("string");
  });

  it("re-mints the dead row in place and tombstones the old order with appointmentId null", async () => {
    const { value, error } = await run();
    expect(error).toBeNull();
    expect(value).not.toBeNull();

    const dead = payments.find((p) => p.id === "pay-dead");
    expect(dead?.paymentIntent).toBe("order_NEW");
    expect(dead?.paymentStatus).toBe("PENDING");

    const tombstone = payments.find((p) => p.paymentIntent === OLD_INTENT);
    expect(tombstone).toMatchObject({
      paymentStatus: "EXPIRED",
      appointmentId: undefined,
    });
  });
});
