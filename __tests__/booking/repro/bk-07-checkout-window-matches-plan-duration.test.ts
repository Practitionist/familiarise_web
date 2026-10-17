/**
 * @jest-environment node
 */

// Invariant: direct checkout refuses a window whose length differs from the plan's duration, before any gateway call.

import "../../booking-algorithm/setup";

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
jest.mock("../../../utils/scheduling-engine/availabilityCoverage", () => ({
  __esModule: true,
  windowAtoms: () => [],
  findUncoveredAtom: () => null,
  loadPublishedCoverage: async () => ({
    scheduleType: "WEEKLY",
    weeklyRows: [],
    customRows: [],
  }),
}));

import { handleCheckout } from "../../../lib/payments/operations/checkout";
import { resetDouble } from "./checkout-harness/setup";
import type { CheckoutInput } from "../../../schemas/checkout";

const START = new Date(Date.now() + 72 * 60 * 60 * 1000);
const SIX_HOURS_LATER = new Date(START.getTime() + 6 * 60 * 60 * 1000);

beforeEach(() => {
  createPaymentIntent.mockReset();
  createPaymentIntent.mockResolvedValue({
    id: "order_new",
    client_secret: "s",
  });
  resetDouble({
    "user.findUnique": () => ({
      id: "buyer",
      consulteeProfile: { id: "cp-buyer", billingStateCode: null },
    }),
    "consultationPlan.findUnique": () => ({
      id: "plan-1",
      price: 100_000,
      priceCurrency: "INR",
      durationInHours: 1,
      archivedAt: null,
      visibility: "PUBLIC",
      status: "PUBLISHED",
      consultantProfileId: "cons-profile",
      consultantProfile: {
        id: "cons-profile",
        userId: "cons-user",
        deletedAt: null,
        verificationStatus: "VERIFIED",
        user: { id: "cons-user", timezone: "Asia/Kolkata" },
      },
    }),
    "availabilityWindowWeekly.findUnique": () => ({
      consultantProfile: {
        id: "cons-profile",
        userId: "cons-user",
        deletedAt: null,
      },
    }),
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("direct checkout window vs plan duration", () => {
  it("refuses a 6 h window on a 1 h plan with a 400/409 before any gateway call", async () => {
    const input = {
      appointmentType: "CONSULTATION",
      planId: "plan-1",
      paymentGateway: "RAZORPAY",
      availabilityWindowWeeklyId: "win-1",
      startsAt: START.toISOString(),
      endsAt: SIX_HOURS_LATER.toISOString(),
    } as unknown as CheckoutInput;

    const outcome = await handleCheckout(input, "buyer").then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    );

    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(outcome.error).not.toBeNull();
    expect([400, 409]).toContain(
      (outcome.error as { httpStatus?: number }).httpStatus,
    );
  });
});
