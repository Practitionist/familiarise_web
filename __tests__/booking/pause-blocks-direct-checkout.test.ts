/**
 * @jest-environment node
 */

// Invariant: a paused expert (acceptingRequests false) takes no new direct booking of any product.

import "../booking-algorithm/setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual("./repro/checkout-harness/setup").db,
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));
const createPaymentIntent = jest.fn();
jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: (...a: unknown[]) => createPaymentIntent(...a),
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("../../utils/appointmentlock", () => ({
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

import { handleCheckout } from "../../lib/payments/operations/checkout";
import { resetDouble } from "./repro/checkout-harness/setup";
import type { CheckoutInput } from "../../schemas/checkout";

const pausedProfile = {
  id: "cons-profile",
  userId: "cons-user",
  deletedAt: null,
  verificationStatus: "VERIFIED",
  acceptingRequests: false,
  user: { id: "cons-user", timezone: "Asia/Kolkata" },
};
const plan = {
  id: "plan-1",
  price: 100_000,
  priceCurrency: "INR",
  durationInHours: 1,
  archivedAt: null,
  visibility: "PUBLIC",
  status: "PUBLISHED",
  organizationId: null,
  consultantProfileId: "cons-profile",
  consultantProfile: pausedProfile,
};
const event = { id: "event-1", status: "SCHEDULED", appointment: null };
const START = new Date(Date.now() + 72 * 3600_000);

const cases: Array<
  [CheckoutInput["appointmentType"], Record<string, unknown>]
> = [
  [
    "CONSULTATION",
    {
      availabilityWindowWeeklyId: "win-1",
      startsAt: START.toISOString(),
      endsAt: new Date(START.getTime() + 3600_000).toISOString(),
    },
  ],
  ["SUBSCRIPTION", {}],
  ["WEBINAR", { eventId: "event-1" }],
  ["CLASS", { eventId: "event-1" }],
];

beforeEach(() => {
  createPaymentIntent.mockReset();
  resetDouble({
    "user.findUnique": () => ({
      id: "buyer",
      consulteeProfile: { id: "cp-buyer", billingStateCode: null },
    }),
    "consultationPlan.findUnique": () => plan,
    "subscriptionPlan.findUnique": () => plan,
    "webinar.findUnique": () => ({ ...event, webinarPlan: plan }),
    "class.findUnique": () => ({ ...event, classPlan: plan }),
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each(cases)(
  "%s checkout refuses with 409 NOT_ACCEPTING_BOOKINGS before any gateway call",
  async (appointmentType, extra) => {
    const input = {
      appointmentType,
      planId: "plan-1",
      paymentGateway: "RAZORPAY",
      ...extra,
    } as unknown as CheckoutInput;

    const error = await handleCheckout(input, "buyer").then(
      () => null,
      (caught: unknown) => caught as { httpStatus?: number; code?: string },
    );

    expect(error).toMatchObject({
      httpStatus: 409,
      code: "NOT_ACCEPTING_BOOKINGS",
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
  },
);
