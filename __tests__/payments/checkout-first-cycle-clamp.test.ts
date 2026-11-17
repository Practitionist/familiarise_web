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
// The first-week room check reads published hours; one free session by default.
const firstWeekRoom = { placeable: 2 };
jest.mock("../../lib/booking/feasibility", () => ({
  __esModule: true,
  assessExpertFeasibility: jest.fn(async () => ({
    verdict: "ok",
    weeks: [
      {
        weekStartMs: 0,
        publishedCapacity: 2,
        placeable: firstWeekRoom.placeable,
      },
    ],
    longestWindowMinutes: 120,
    bestWeekPublishedSessions: 2,
    reasons: [],
  })),
  firstWeekPlaceable: (report: { weeks: { placeable: number }[] }) =>
    report.weeks[0]?.placeable ?? 0,
}));
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
jest.mock("../../lib/enterprise/system-events", () => {
  return {
    __esModule: true,
    recordSystemError: () => Promise.resolve(),
    recordSystemErrorSafe: () => Promise.resolve(),
  };
});
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

import { assessExpertFeasibility } from "../../lib/booking/feasibility";
import { handleSubscriptionCheckout } from "../../lib/payments/checkout/handlers/subscription";
import {
  classifyError,
  isBusinessErrorCode,
} from "../../lib/errors/classification/payment-error-classification";
import type { Tx } from "../../lib/prisma";
import { checkoutSchema, type CheckoutInput } from "../../schemas/checkout";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const START = new Date("2026-03-02T09:00:00.000Z");
// The buyer is on the page the day before their chosen start.
beforeEach(() => {
  jest.useFakeTimers({
    advanceTimers: true,
    now: new Date("2026-03-01T12:00:00.000Z"),
  });
});
afterEach(() => {
  jest.useRealTimers();
});

/** A live subscription of this plan the buyer already holds (#1766). */
function heldRow(completed: number) {
  return {
    sessionsTotal: 24,
    sessionsPerWeek: null,
    sessionsRefunded: 0,
    schedulingPeriodStartsAt: new Date("2026-02-02T00:00:00.000Z"),
    schedulingTimezone: "Asia/Kolkata",
    subscriptionPlan: {
      totalSessions: 24,
      sessionsPerWeek: 2,
      durationInMonths: 3,
    },
    appointment: {
      occurrences: Array.from({ length: completed }, (_, i) => ({
        startsAt: new Date(START.getTime() - (i + 1) * DAY),
        endsAt: new Date(START.getTime() - (i + 1) * DAY + HOUR),
        completionStatus: "COMPLETED",
        isTentative: false,
        deletedAt: null,
      })),
    },
  };
}

function makeTx(liveRows: ReturnType<typeof heldRow>[] = []) {
  const tx = {
    subscriptionPlan: {
      findUnique: jest.fn().mockResolvedValue({
        id: "plan-1",
        price: 240_000,
        durationInMonths: 3,
        durationInWeeks: null,
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
        totalSessions: 24,
        consultantProfileId: "cp-1",
        consultantProfile: { user: { timezone: "Asia/Kolkata" } },
      }),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue(liveRows),
      create: jest.fn().mockResolvedValue({ id: "sub-1" }),
    },
    trial: { findFirst: jest.fn().mockResolvedValue(null) },
    // No limit on live plan clients unless a test sets one.
    consultantProfile: {
      findUnique: jest.fn().mockResolvedValue({ maxActivePlanClients: null }),
    },
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
  // 02 Mar IST is day one; the window ends (exclusive) at 09 Mar 00:00 IST.
  expect(data.schedulingPeriodEndsAt.toISOString()).toBe(
    "2026-03-08T18:30:00.000Z",
  );
  // The plan end is written once, here: start + 3 months on the IST clock.
  expect(data.planEndsAt.toISOString()).toBe("2026-06-02T09:00:00.000Z");
  expect(data.sessionsTotal).toBe(24);
  // The cadence and length are frozen with it; plan edits never move them.
  expect(data.sessionsPerWeek).toBe(2);
  expect(data.sessionMinutes).toBe(60);
  expect(data.schedulingTimezone).toBe("Asia/Kolkata");
  // The first-week room also counts the expert's other sold, unplaced plans.
  expect(assessExpertFeasibility).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({ planDemand: { excludeSubscriptionIds: [] } }),
  );
  // The buyer holds a seat on the placeholder from the moment of purchase.
  const seated = (tx.appointmentParticipant.createMany as jest.Mock).mock
    .calls[0][0].data;
  expect(seated).toEqual([
    expect.objectContaining({
      appointmentId: "apt-1",
      userId: "buyer-user",
      role: "CONSULTEE",
      status: "HELD",
    }),
  ]);
});

function trialTx() {
  const tx = makeTx();
  const trial = {
    findFirst: jest.fn().mockResolvedValue({ id: "trial-1" }),
    findUnique: jest.fn().mockResolvedValue({
      status: "COMPLETED",
      appointmentId: null,
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn(),
  };
  Object.assign(tx, { trial });
  Object.assign(tx.subscription, {
    findUnique: jest.fn().mockResolvedValue({
      requestedById: "consultee-profile-1",
      subscriptionPlan: { consultantProfileId: "cp-1" },
    }),
  });
  return { tx, trial };
}

const checkout = (tx: ReturnType<typeof makeTx>, skipPayment: boolean) =>
  handleSubscriptionCheckout(
    tx,
    {
      appointmentType: "SUBSCRIPTION",
      planId: "plan-1",
      schedulingPeriodStartsAt: START.toISOString(),
    } as unknown as CheckoutInput,
    "consultee-profile-1",
    skipPayment,
    null,
    "policy-1",
  );

it("a card checkout leaves the completed trial alone: it converts at capture", async () => {
  const { tx, trial } = trialTx();
  await checkout(tx, false);
  expect(trial.updateMany).not.toHaveBeenCalled();
  expect(trial.update).not.toHaveBeenCalled();
});

it("a checkout paid on the spot converts the pair's trial through the CAS helper", async () => {
  const { tx, trial } = trialTx();
  await checkout(tx, true);
  expect(trial.update).not.toHaveBeenCalled();
  expect(trial.updateMany).toHaveBeenCalledWith({
    where: { id: "trial-1", status: { in: ["COMPLETED"] } },
    data: { status: "CONVERTED", convertedToSubscriptionId: "sub-1" },
  });
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

// #1766 — the double-buy guard follows the entitlement, not the window.
describe("double-buy guard", () => {
  const checkout = (tx: Tx) =>
    handleSubscriptionCheckout(
      tx,
      {
        appointmentType: "SUBSCRIPTION",
        planId: "plan-1",
        schedulingPeriodStartsAt: START.toISOString(),
      } as unknown as CheckoutInput,
      "consultee-profile-1",
      false,
      null,
      "policy-1",
    );

  it("refuses a plan whose first week the expert's hours can't hold at all", async () => {
    firstWeekRoom.placeable = 0;
    try {
      const tx = makeTx();
      const error = await checkout(tx).catch((e: unknown) => e);
      expect(error).toMatchObject({ httpStatus: 409, code: "NOT_PLACEABLE" });
      expect(tx.subscription.create).not.toHaveBeenCalled();
      expect(isBusinessErrorCode("NOT_PLACEABLE")).toBe(true);
      expect(classifyError(error)).toMatchObject({
        httpStatus: 409,
        errorType: "NOT_PLACEABLE_ERROR",
      });
    } finally {
      firstWeekRoom.placeable = 2;
    }
  });

  it("refuses with a typed 409 while a live row has sessions left", async () => {
    const tx = makeTx([heldRow(4)]);
    const error = await checkout(tx).catch((e: unknown) => e);

    expect(error).toMatchObject({
      httpStatus: 409,
      code: "SUBSCRIPTION_ALREADY_ACTIVE",
      message:
        "You already have this plan with 20 sessions left. Your expert schedules them, so you can buy it again once they are used.",
    });
    expect(tx.subscription.create).not.toHaveBeenCalled();
    // The tx catch rethrows any registered code unchanged and the route
    // classifies it to its own status, type and the thrown sentence.
    expect(isBusinessErrorCode("SUBSCRIPTION_ALREADY_ACTIVE")).toBe(true);
    expect(classifyError(error)).toMatchObject({
      httpStatus: 409,
      errorType: "SUBSCRIPTION_ALREADY_ACTIVE_ERROR",
      errorMessage:
        "You already have this plan with 20 sessions left. Your expert schedules them, so you can buy it again once they are used.",
    });
    // The read drops the window terms: status + plan + buyer only.
    const { where } = (tx.subscription.findMany as jest.Mock).mock.calls[0][0];
    expect(where.schedulingPeriodStartsAt).toBeUndefined();
    expect(where.OR).toBeUndefined();
    expect(where.status.in).toEqual(["PENDING", "APPROVED"]);
  });

  it("lets a spent plan be bought again (renewal as repurchase)", async () => {
    const tx = makeTx([heldRow(24)]);
    await checkout(tx);
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
  });
});
