// Module mocks and fixtures for driving handleCheckout end to end; import before the module under test.

import type { CheckoutInput } from "../../../../../schemas/checkout";

export const mockCreatePaymentIntent = jest.fn();

jest.mock("../../../../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual("../setup").db,
}));
jest.mock("../../../../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: (...a: unknown[]) => mockCreatePaymentIntent(...a),
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("../../../../../utils/appointmentlock", () => ({
  __esModule: true,
  CHECKOUT_WAIT_RETRY_CONFIG: { retryCount: 5 },
  CHECKOUT_LOCK_TTL_MS: {},
  EventFullError: class extends Error {},
  EventCheckoutBusyError: class extends Error {},
  ConsulteeBookingBusyError: class extends Error {},
  lockSlotBooking: jest.fn(async () => ({ key: "k" })),
  unlockSlotBooking: jest.fn(),
  lockSlotBatch: jest.fn(async () => ({ keys: ["slot"], token: "t" })),
  unlockSlotInterval: jest.fn(),
  lockEventCheckout: jest.fn(async () => ({ key: "k" })),
  unlockEventCheckout: jest.fn(),
  lockConsulteeBooking: jest.fn(async () => ({ key: "k" })),
  unlockConsulteeBooking: jest.fn(),
  RequestCapBusyError: class extends Error {},
  lockRequestCap: jest.fn(async () => ({ key: "cap" })),
  unlockRequestCap: jest.fn(),
  extendLock: jest.fn(async () => true),
  extendSlotInterval: jest.fn(async () => true),
}));
jest.mock("../../../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));

/** The buyer row checkout's pricing step reads. */
export function buyerRow(id = "buyer") {
  return { id, consulteeProfile: { id: "cp-buyer", billingStateCode: null } };
}

/** A checkout body with the route's defaults; each test names only what it varies. */
export function buildCheckoutInput(
  overrides: Pick<CheckoutInput, "appointmentType"> & Partial<CheckoutInput>,
): CheckoutInput {
  return {
    planId: "plan-1",
    paymentGateway: "RAZORPAY",
    consumerStateCode: "29",
    ...overrides,
  };
}

/** The gateway mints order `id` for the next checkout. */
export function mintOrder(id: string): void {
  mockCreatePaymentIntent.mockReset();
  mockCreatePaymentIntent.mockResolvedValue({ id, client_secret: "s" });
}

export function silenceConsole(): void {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
}

const WEBINAR_START = new Date(Date.now() + 72 * 3600_000);

/** A published, buyer-paid webinar plan owned by `cons-profile`. */
export const webinarPlan = {
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
};

/** One scheduled `web-1` session three days out, on appointment `appt-webinar`. */
export const webinar = {
  id: "web-1",
  status: "SCHEDULED",
  webinarPlan,
  appointment: {
    id: "appt-webinar",
    occurrences: [
      {
        id: "occ-1",
        startsAt: WEBINAR_START,
        endsAt: new Date(WEBINAR_START.getTime() + 3600_000),
        deletedAt: null,
        completionStatus: "SCHEDULED",
      },
    ],
    participants: [],
  },
};

/** The in-lock event-plan lookup: owned by `cons-profile`, no collaborators. */
export function eventPlanLookup() {
  return {
    consultantProfileId: "cons-profile",
    organizationId: null,
    collaborators: [],
  };
}

/** An active `org-1` member on the given rail with programme assignment `pa-1`. */
export function orgMember(
  fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" = "PERSONAL",
  membershipStatus = "ACTIVE",
) {
  return {
    "organization.findUnique": () => ({
      id: "org-1",
      status: "ACTIVE",
      canSponsor: true,
      billingAccount: {
        id: "ba-1",
        fundingSource,
        creditLimit: null,
        walletBalance: 0,
      },
    }),
    "billingAccount.findFirst": () => ({
      id: "ba-1",
      fundingSource,
      creditLimit: null,
    }),
    "membership.findUnique": () => ({
      id: "m-1",
      role: "LEARNER",
      status: membershipStatus,
    }),
    "programAssignment.findFirst": () => ({ id: "pa-1", programId: "prog-1" }),
  };
}
