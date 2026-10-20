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
  lockSlotBooking: jest.fn(async () => ({ key: "k" })),
  unlockSlotBooking: jest.fn(),
  lockEventCheckout: jest.fn(async () => ({ key: "k" })),
  unlockEventCheckout: jest.fn(),
  lockConsulteeBooking: jest.fn(async () => ({ key: "k" })),
  unlockConsulteeBooking: jest.fn(),
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
