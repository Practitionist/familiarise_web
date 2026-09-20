/**
 * @jest-environment node
 */

/**
 * #1766 — a subscription's scheduling window is the FIRST CYCLE only, derived
 * on the server from the client's start; the client's end is ignored, never
 * refused. The entitlement is frozen on the row at purchase.
 *
 * Module-scope mocks mirror class-checkout-planned-sessions.test.ts so the
 * one exported handler runs against a hand-built transaction.
 */

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startSpan: (_o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
  reverseEarningsForPayment: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  __esModule: true,
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: () => Promise.resolve(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/payments/utils/slot-validation", () => ({
  __esModule: true,
  validateSlotTiming: jest.fn().mockReturnValue(null),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getWebinarCapacity: jest.fn(),
  getClassCapacity: jest.fn(),
}));

import { handleSubscriptionCheckout } from "../../lib/payments/operations/checkout";
import type { Tx } from "../../lib/prisma";
import { checkoutSchema, type CheckoutInput } from "../../schemas/checkout";

const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-03-02T09:00:00.000Z");

function makeTx() {
  const tx = {
    subscriptionPlan: {
      findUnique: jest.fn().mockResolvedValue({
        id: "plan-1",
        price: 240_000,
        durationInMonths: 3,
        sessionsPerWeek: 2,
        totalSessions: 24,
        consultantProfileId: "cp-1",
        consultantProfile: { user: { timezone: "Asia/Kolkata" } },
      }),
    },
    subscription: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "sub-1" }),
    },
    trial: { findFirst: jest.fn().mockResolvedValue(null) },
    appointment: { create: jest.fn().mockResolvedValue({ id: "apt-1" }) },
    consulteeProfile: {
      findUnique: jest.fn().mockResolvedValue({ userId: "buyer-user" }),
    },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
  return tx as unknown as Tx;
}

it("persists end = start + 7 zone-days and sessionsTotal = 24 despite a 90-day client window", async () => {
  const tx = makeTx();
  await handleSubscriptionCheckout(
    tx,
    {
      appointmentType: "SUBSCRIPTION",
      planId: "plan-1",
      schedulingPeriodStartsAt: START.toISOString(),
      schedulingPeriodEndsAt: new Date(
        START.getTime() + 90 * DAY,
      ).toISOString(),
    } as unknown as CheckoutInput,
    "consultee-profile-1",
    false,
    null,
    "policy-1",
  );

  const { data } = (tx.subscription.create as jest.Mock).mock.calls[0][0];
  expect(data.schedulingPeriodStartsAt).toEqual(START);
  // 02 Mar IST is day one; the seventh day ends 08 Mar 23:59:59.999 IST.
  expect(data.schedulingPeriodEndsAt.toISOString()).toBe(
    "2026-03-08T18:29:59.999Z",
  );
  expect(data.sessionsTotal).toBe(24);
  expect(data.schedulingTimezone).toBe("Asia/Kolkata");
});

it("the Zod edge accepts a start alone and still refuses a reversed pair", () => {
  const base = { appointmentType: "SUBSCRIPTION", planId: "plan-1" };
  expect(
    checkoutSchema.safeParse({
      ...base,
      schedulingPeriodStartsAt: START.toISOString(),
    }).success,
  ).toBe(true);
  expect(
    checkoutSchema.safeParse({
      ...base,
      schedulingPeriodStartsAt: START.toISOString(),
      schedulingPeriodEndsAt: new Date(START.getTime() - DAY).toISOString(),
    }).success,
  ).toBe(false);
});
