/**
 * @jest-environment node
 */

/**
 * A ban ends a plan at the expert-side cancel quote: every undelivered session
 * refunds in full, a delivered one keeps its earnings, whoever was banned, and
 * a live plan is collected whether or not a session is placed ahead.
 */
import { PLATFORM_DEFAULT_TERMS } from "@/lib/payments/operations/cancellation-policy";
import { STAFF_CANCEL_REFUND_REASON } from "@/lib/payments/operations/refund-cause";

type Where = Record<string, unknown> & {
  appointment?: { occurrences?: unknown };
};
type Marker = { paymentId: string; amountPaise: number | null; key: string };

const mockUserFindUnique = jest.fn();
const mockSubscriptionFindMany = jest.fn(
  async (_args: { where: Where }): Promise<{ id: string }[]> => [],
);
const mockConsultationFindMany = jest.fn(
  async (_args: { where: Where }): Promise<{ id: string }[]> => [],
);
const mockContext = jest.fn();
const mockStampOwedOrHeld = jest.fn(
  async (_tx: unknown, _marker: Marker) => null,
);
const mockDrive = jest.fn();
const mockStampTranches = jest.fn(async (..._args: unknown[]) => 0);
const mockTransitionSubscription = jest.fn(async (..._args: unknown[]) => {});
const mockTransitionConsultation = jest.fn(async (..._args: unknown[]) => {});

const mockPlanNow = jest.fn();
const mockTx = {
  appointmentOccurrence: { updateMany: jest.fn(async () => ({ count: 0 })) },
  subscription: { findUnique: (...a: unknown[]) => mockPlanNow(...a) },
  referralCreditUsage: {
    aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
  },
};

const ENGAGEMENT = {
  requestedBy: { user: { id: "learner-user", name: "Ada" } },
  appointment: {
    id: "appt-1",
    appointmentType: "SUBSCRIPTION",
    organizationId: null,
    payment: [
      {
        id: "pay-1",
        amount: 3_600_000,
        paymentStatus: "SUCCEEDED",
        deletedAt: null,
      },
    ],
  },
};
const PLAN_ROW = {
  title: "Plan",
  consultantProfile: { user: { id: "expert-user", name: "Dr Who" } },
};

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
    subscription: {
      findMany: (a: { where: Where }) => mockSubscriptionFindMany(a),
      findUnique: async () => ({ ...ENGAGEMENT, subscriptionPlan: PLAN_ROW }),
    },
    consultation: {
      findMany: (a: { where: Where }) => mockConsultationFindMany(a),
      findUnique: async () => ({ ...ENGAGEMENT, consultationPlan: PLAN_ROW }),
    },
    webinar: { findMany: async () => [] },
    class: { findMany: async () => [] },
    appointmentOccurrence: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(mockTx),
  },
}));
jest.mock("@/lib/booking/transitions", () => ({
  ...jest.requireActual("@/lib/booking/transitions"),
  transitionSubscriptionRequest: (...a: unknown[]) =>
    mockTransitionSubscription(...a),
  transitionConsultationRequest: (...a: unknown[]) =>
    mockTransitionConsultation(...a),
  transitionOccurrenceCompletion: jest.fn(async () => 0),
}));
jest.mock("@/lib/booking/cancellation-scope", () => ({
  resolveBookingRefundContext: (...a: unknown[]) => mockContext(...a),
}));
jest.mock("@/lib/booking/subscription-cycle", () => ({
  stampTranchesOnCancel: (...a: unknown[]) => mockStampTranches(...a),
}));
jest.mock("@/lib/booking/reschedule-decline", () => ({
  declineOpenReschedules: jest.fn(async () => {}),
}));
jest.mock("@/lib/booking/participants", () => ({
  liveParticipant: () => ({}),
  releaseParticipant: jest.fn(),
}));
jest.mock("@/lib/collaborators/recipients", () => ({
  collaboratorUserIdsForEvent: jest.fn(async () => []),
}));
jest.mock("@/utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
  withEventCheckoutLock: (_key: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn(async () => []),
}));
jest.mock("@/lib/email", () => ({
  EMAIL_BUDGET_MS: { JOB: 1 },
  sendAppointmentCancelledEmail: jest.fn(async () => {}),
}));
jest.mock("@/lib/payments/operations/refund-owed", () => ({
  driveRefundOwed: (...a: unknown[]) => mockDrive(...a),
  stampOwedOrHeld: (tx: unknown, marker: Marker) =>
    mockStampOwedOrHeld(tx, marker),
  opsHeldMarkerMessage: () => null,
  recordRefundNeedsSupport: jest.fn(async () => {}),
}));
jest.mock("@/lib/payments/operations/refund", () => ({
  isModelledRefundRefusal: () => false,
}));
jest.mock("@/lib/payments/operations/event-refunds", () => ({}));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(async () => {}),
  recordSystemEvent: jest.fn(async () => {}),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { cancelFutureEngagementsForUser } from "@/lib/moderation/cancel-user-engagements";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

const HOUR = 3_600_000;
const NOW = Date.now();
/** ₹36,000 for 24 sessions: ₹1,500 a session. */
const PLAN_PAISE = 3_600_000;
/** What the payment under test can still give back. */
let balancePaise = PLAN_PAISE;

/** The plan as the refund context reads it; sessions placed ahead start within the hour. */
function planContext(opts: {
  delivered: number;
  placedAhead: number;
  sessionsRefunded?: number;
  windowState?: "BEFORE" | "IN_PROGRESS" | "DELIVERED";
}) {
  const sessionsRefunded = opts.sessionsRefunded ?? 0;
  balancePaise = PLAN_PAISE - sessionsRefunded * 150_000;
  return {
    paidPayment: {
      id: "pay-1",
      amountPaise: PLAN_PAISE,
      paymentIntent: "order_1",
      listPricePaise: PLAN_PAISE,
      refundablePaise: balancePaise,
    },
    policy: PLATFORM_DEFAULT_TERMS,
    hoursUntilNextSession: opts.placedAhead > 0 ? 1 : null,
    sessionsCompleted: opts.delivered,
    sessionsRemaining: opts.placedAhead,
    sessionsTotal: 24,
    sessionsRefunded,
    scheduledStarts: Array.from(
      { length: opts.placedAhead },
      (_, i) => NOW + (i + 1) * HOUR,
    ),
    quotedAtMs: NOW,
    alreadyRefundedPaise: 0,
    slotsTotal: opts.delivered + opts.placedAhead,
    confirmedSlotsTotal: opts.delivered + opts.placedAhead,
    windowState: opts.windowState ?? "BEFORE",
  };
}

const ban = (userId: string) =>
  cancelFutureEngagementsForUser(userId, { initiatedByUserId: "admin-1" });

const expertIsBanned = () =>
  mockUserFindUnique.mockResolvedValue({
    consulteeProfileId: null,
    consultantProfileId: "expert-profile",
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscriptionFindMany.mockResolvedValue([{ id: "sub-1" }]);
  mockConsultationFindMany.mockResolvedValue([]);
  // The front door refunds the stamped amount; a null amount is the whole balance.
  mockDrive.mockImplementation(async (marker: Marker) => ({
    kind: "refunded",
    refund: {
      refundId: "r-1",
      amountRefundedPaise: marker.amountPaise ?? balancePaise,
    },
  }));
});

describe("a ban refunds a plan for what was not delivered", () => {
  it("expert banned with 8 of 24 delivered: ₹24,000 back, and the kept tranches start their hold", async () => {
    expertIsBanned();
    mockContext.mockResolvedValue(
      planContext({ delivered: 8, placedAhead: 2 }),
    );

    const summary = await ban("expert-user");

    expect(mockStampOwedOrHeld).toHaveBeenCalledWith(mockTx, {
      paymentId: "pay-1",
      amountPaise: 2_400_000,
      key: "moderation:appt-1:pay-1",
      reason: STAFF_CANCEL_REFUND_REASON.MODERATION,
    });
    expect(summary.refundedPaise).toBe(2_400_000);
    expect(mockStampTranches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    // The quote is read on the cancel's own transaction, before the sessions are released.
    expect(mockContext).toHaveBeenCalledWith(
      { appointmentId: "appt-1", subscriptionId: "sub-1" },
      undefined,
      mockTx,
    );
  });

  it("learner banned, same plan: the same ₹24,000", async () => {
    mockUserFindUnique.mockResolvedValue({
      consulteeProfileId: "learner-profile",
      consultantProfileId: null,
    });
    mockContext.mockResolvedValue(
      planContext({ delivered: 8, placedAhead: 2 }),
    );

    const summary = await ban("learner-user");

    expect(mockSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestedById: "learner-profile" }),
      }),
    );
    expect(summary.refundedPaise).toBe(2_400_000);
  });

  it("a plan with 2 sessions already refunded by support never pays them twice: ₹21,000", async () => {
    expertIsBanned();
    mockContext.mockResolvedValue(
      planContext({ delivered: 8, placedAhead: 2, sessionsRefunded: 2 }),
    );

    const summary = await ban("expert-user");

    expect(summary.refundedPaise).toBe(2_100_000);
    // The cancel is pinned to the removed-session count the quote read.
    expect(mockTransitionSubscription).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ where: { id: "sub-1", sessionsRefunded: 2 } }),
    );
  });

  it("collects a live plan with nothing placed ahead", async () => {
    expertIsBanned();
    // The database's answer for a plan with no future session.
    mockSubscriptionFindMany.mockImplementation(async ({ where }) =>
      where.appointment?.occurrences ? [] : [{ id: "sub-1" }],
    );
    mockContext.mockResolvedValue(
      planContext({ delivered: 8, placedAhead: 0 }),
    );

    const summary = await ban("expert-user");

    expect(summary.engagementsCancelled).toBe(1);
    expect(summary.refundedPaise).toBe(2_400_000);
  });

  it("leaves a plan with every session held and none owed to the plan end", async () => {
    expertIsBanned();
    mockContext.mockResolvedValue(
      planContext({ delivered: 24, placedAhead: 0, windowState: "DELIVERED" }),
    );

    const summary = await ban("expert-user");

    expect(mockTransitionSubscription).not.toHaveBeenCalled();
    expect(summary.engagementsCancelled).toBe(0);
    expect(mockDrive).not.toHaveBeenCalled();
  });

  it("a support refund landing under the quote fails the plan into a re-run, with nothing refunded", async () => {
    expertIsBanned();
    mockContext.mockResolvedValue(
      planContext({ delivered: 8, placedAhead: 2 }),
    );
    mockTransitionSubscription.mockRejectedValueOnce(
      new IllegalTransitionError("Subscription", "CANCELLED"),
    );
    mockPlanNow.mockResolvedValue({ status: "APPROVED", sessionsRefunded: 2 });

    const summary = await ban("expert-user");

    expect(summary.engagementsCancelled).toBe(0);
    expect(mockDrive).not.toHaveBeenCalled();
    expect(summary.failures).toEqual([
      expect.objectContaining({
        kind: "subscription",
        id: "sub-1",
        error: expect.stringContaining("re-run"),
      }),
    ]);
  });

  it("a plan with a session under way is still ended, and that session refunds as undelivered", async () => {
    expertIsBanned();
    mockContext.mockResolvedValue({
      ...planContext({ delivered: 8, placedAhead: 1 }),
      scheduledStarts: [NOW - HOUR / 2],
      windowState: "IN_PROGRESS",
    });

    const summary = await ban("expert-user");

    expect(summary.engagementsCancelled).toBe(1);
    expect(summary.refundedPaise).toBe(2_400_000);
  });
});

describe("a ban on a single-session consultation", () => {
  it("not yet held: still refunds in full", async () => {
    expertIsBanned();
    mockSubscriptionFindMany.mockResolvedValue([]);
    mockConsultationFindMany.mockResolvedValue([{ id: "con-1" }]);
    const session = planContext({ delivered: 0, placedAhead: 1 });
    balancePaise = 150_000;
    mockContext.mockResolvedValue({
      ...session,
      paidPayment: {
        id: "pay-1",
        amountPaise: 150_000,
        paymentIntent: "order_1",
        listPricePaise: 150_000,
        refundablePaise: 150_000,
      },
      sessionsTotal: null,
    });

    const summary = await ban("expert-user");

    expect(summary.engagementsCancelled).toBe(1);
    expect(summary.refundedPaise).toBe(150_000);
    expect(mockStampTranches).not.toHaveBeenCalled();
  });
});
