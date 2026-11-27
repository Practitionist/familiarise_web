/**
 * @jest-environment node
 */

/**
 * A ban ends a plan at the expert-side cancel quote: every undelivered session
 * refunds in full, a delivered one keeps its earnings, whoever was banned, and
 * a live plan is collected whether or not a session is placed ahead. A banned
 * learner's class or webinar seat is refunded the same way, from its ledger.
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
const mockTransitionWebinar = jest.fn(async (..._args: unknown[]) => {});
const mockHostedWebinars = jest.fn(async (): Promise<{ id: string }[]> => []);
const mockTransaction = jest.fn(
  async (fn: (tx: unknown) => unknown, _options?: unknown) => fn(mockTx),
);

const mockPlanNow = jest.fn();
const mockSessionsLeft = jest.fn(
  async (_args: { where: Record<string, unknown> }) => mockSeat.upcoming,
);
/** The banned learner's seat on a class or webinar, as the removal reads it. */
const mockSeat = {
  events: [] as { webinarId: string | null; classId: string | null }[],
  upcoming: 0,
  amount: 800_000,
  /** The seat's price before credits and discounts. */
  listPaise: 800_000,
  paymentIntent: "order_seat",
  totalSessions: 8 as number | null,
  sessionsPurchased: 8 as number | null,
  occurrences: [] as Record<string, unknown>[],
};
const mockTx = {
  appointmentOccurrence: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    findMany: jest.fn(async () => mockSeat.occurrences),
  },
  appointmentParticipant: {
    findUnique: jest.fn(async () => ({
      createdAt: new Date(0),
      sessionsPurchased: mockSeat.sessionsPurchased,
    })),
  },
  appointment: {
    findMany: jest.fn(async () => [
      {
        id: "appt-1",
        class:
          mockSeat.totalSessions === null
            ? null
            : { classPlan: { totalSessions: mockSeat.totalSessions } },
      },
    ]),
  },
  payment: {
    // Answers the lookup's own filter, as the database would.
    findFirst: jest.fn(
      async ({ where }: { where: { amount?: { gt: number } } }) =>
        where.amount && mockSeat.amount <= where.amount.gt
          ? null
          : {
              id: "pay-seat",
              amount: mockSeat.amount,
              originalAmount: mockSeat.listPaise,
              paymentIntent: mockSeat.paymentIntent,
              createdAt: new Date(0),
              refunds: [],
              disputes: [],
            },
    ),
  },
  refund: { findMany: jest.fn(async () => []) },
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
  ALLOCATION_TX_MAX_WAIT_MS: 8_000,
  ALLOCATION_TX_TIMEOUT_MS: 30_000,
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
    webinar: { findMany: () => mockHostedWebinars() },
    class: { findMany: async () => [] },
    appointmentOccurrence: {
      findMany: async () =>
        mockSeat.events.map((appointment) => ({ appointment })),
      count: (args: { where: Record<string, unknown> }) =>
        mockSessionsLeft(args),
    },
    appointment: { findFirst: async () => ({ id: "appt-1" }) },
    $transaction: (fn: (tx: unknown) => unknown, options?: unknown) =>
      mockTransaction(fn, options),
  },
}));
jest.mock("@/lib/booking/transitions", () => ({
  ...jest.requireActual("@/lib/booking/transitions"),
  transitionSubscriptionRequest: (...a: unknown[]) =>
    mockTransitionSubscription(...a),
  transitionConsultationRequest: (...a: unknown[]) =>
    mockTransitionConsultation(...a),
  transitionWebinarEvent: (...a: unknown[]) => mockTransitionWebinar(...a),
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
  releaseParticipant: jest.fn(async () => 1),
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
  RefundValidationError: class extends Error {},
}));
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(async () => {}),
  recordSystemEvent: jest.fn(async () => {}),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { cancelFutureEngagementsForUser } from "@/lib/moderation/cancel-user-engagements";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

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
  mockSeat.events = [];
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

describe("a ban on a learner who holds a class or webinar seat", () => {
  const DAY = 24 * HOUR;

  /** Hour-long sessions, one a day, with session 1 starting `firstStartMs` from now. */
  const daily = (count: number, firstStartMs: number) =>
    Array.from({ length: count }, (_, i) => {
      const startsAt = new Date(NOW + firstStartMs + i * DAY);
      const endsAt = new Date(startsAt.getTime() + HOUR);
      return {
        appointmentId: "appt-1",
        ordinal: i + 1,
        startsAt,
        endsAt,
        completionStatus: endsAt.getTime() <= NOW ? "COMPLETED" : "SCHEDULED",
        movedAt: null,
        hostCancelledAt: null,
        voidedAt: null,
        outcome: null,
      };
    });

  const learnerIsBanned = (seat: Partial<typeof mockSeat>) => {
    mockUserFindUnique.mockResolvedValue({
      consulteeProfileId: "learner-profile",
      consultantProfileId: null,
    });
    mockSubscriptionFindMany.mockResolvedValue([]);
    Object.assign(mockSeat, {
      events: [{ webinarId: null, classId: "cls-1" }],
      upcoming: 1,
      amount: 800_000,
      listPaise: 800_000,
      paymentIntent: "order_seat",
      totalSessions: 8,
      sessionsPurchased: 8,
      ...seat,
    });
    balancePaise = mockSeat.amount;
  };

  it("after 3 of 8 class sessions: ₹5,000 back, the three delivered kept", async () => {
    learnerIsBanned({ occurrences: daily(8, -3 * DAY + 2 * HOUR) });

    const summary = await ban("learner-user");

    expect(mockStampOwedOrHeld).toHaveBeenCalledWith(mockTx, {
      paymentId: "pay-seat",
      amountPaise: 500_000,
      key: "moderation:appt-1:pay-seat",
      reason: STAFF_CANCEL_REFUND_REASON.MODERATION,
    });
    expect(summary.attendeeRemovals).toBe(1);
    expect(summary.refundedPaise).toBe(500_000);
  });

  it("banned while session 4 is under way: that session is not delivered, so still ₹5,000", async () => {
    learnerIsBanned({ occurrences: daily(8, -3 * DAY - HOUR / 2) });

    const summary = await ban("learner-user");

    expect(summary.refundedPaise).toBe(500_000);
  });

  it("a webinar that has not ended: the seat is refunded in full", async () => {
    learnerIsBanned({
      events: [{ webinarId: "web-1", classId: null }],
      amount: 100_000,
      totalSessions: null,
      sessionsPurchased: null,
      occurrences: daily(1, 2 * DAY),
    });

    const summary = await ban("learner-user");

    expect(mockStampOwedOrHeld).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ paymentId: "pay-seat", amountPaise: 100_000 }),
    );
    expect(summary.refundedPaise).toBe(100_000);
  });

  describe("on a seat paid entirely in credits", () => {
    const credits = { amount: 0, paymentIntent: "free_seat" };

    it("with nothing delivered: the credit is restored whole", async () => {
      learnerIsBanned({ ...credits, occurrences: daily(8, 2 * DAY) });

      const summary = await ban("learner-user");

      expect(summary.attendeeRemovals).toBe(1);
      expect(mockStampOwedOrHeld).toHaveBeenCalledWith(mockTx, {
        paymentId: "pay-seat",
        amountPaise: null,
        key: "moderation:appt-1:pay-seat",
        reason: STAFF_CANCEL_REFUND_REASON.MODERATION,
      });
    });

    it("after 3 of 8 sessions: the credits rail cannot split, so a person returns the rest", async () => {
      learnerIsBanned({
        ...credits,
        occurrences: daily(8, -3 * DAY + 2 * HOUR),
      });

      await ban("learner-user");

      expect(mockStampOwedOrHeld).not.toHaveBeenCalled();
      expect(recordSystemEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: "partial-credit:pay-seat",
          db: mockTx,
        }),
      );
    });

    it("a seat that was free to begin with owes nothing and writes no refund", async () => {
      learnerIsBanned({
        ...credits,
        listPaise: 0,
        occurrences: daily(8, 2 * DAY),
      });

      const summary = await ban("learner-user");

      expect(summary.attendeeRemovals).toBe(1);
      expect(mockStampOwedOrHeld).not.toHaveBeenCalled();
      expect(recordSystemEvent).not.toHaveBeenCalled();
    });
  });

  it("banned mid-webinar: the session has not ended, so the seat is still refunded in full", async () => {
    learnerIsBanned({
      events: [{ webinarId: "web-1", classId: null }],
      amount: 100_000,
      totalSessions: null,
      sessionsPurchased: null,
      occurrences: daily(1, -HOUR / 2),
    });

    const summary = await ban("learner-user");

    expect(summary.refundedPaise).toBe(100_000);
    // A seat is live while its event has a session that has not ended.
    expect(mockSessionsLeft).toHaveBeenCalledWith({
      where: expect.objectContaining({
        completionStatus: "SCHEDULED",
        endsAt: { gt: expect.any(Date) },
      }),
    });
  });

  it("a webinar that has ended has no session left: the seat is left alone and nothing is refunded", async () => {
    learnerIsBanned({
      events: [{ webinarId: "web-1", classId: null }],
      upcoming: 0,
      amount: 100_000,
      occurrences: daily(1, -2 * DAY),
    });

    const summary = await ban("learner-user");

    expect(summary.attendeeRemovals).toBe(0);
    expect(mockStampOwedOrHeld).not.toHaveBeenCalled();
    expect(mockDrive).not.toHaveBeenCalled();
  });
});

describe("a ban's transactions run under the allocation limits, not the 5-second default", () => {
  const LIMITS = { maxWait: 8_000, timeout: 30_000 };

  it("the plan cancel and the hosted event cancel", async () => {
    expertIsBanned();
    mockContext.mockResolvedValue(
      planContext({ delivered: 8, placedAhead: 2 }),
    );
    mockHostedWebinars.mockResolvedValueOnce([{ id: "web-1" }]);
    // The webinar is already terminal: its transaction opens and moves nothing.
    mockTransitionWebinar.mockRejectedValueOnce(
      new IllegalTransitionError("Webinar", "CANCELLED"),
    );

    const summary = await ban("expert-user");

    expect(summary.failures).toEqual([]);
    expect(mockTransaction.mock.calls.map(([, options]) => options)).toEqual([
      LIMITS,
      LIMITS,
    ]);
  });

  it("the banned learner's seat release", async () => {
    mockUserFindUnique.mockResolvedValue({
      consulteeProfileId: "learner-profile",
      consultantProfileId: null,
    });
    mockSubscriptionFindMany.mockResolvedValue([]);
    Object.assign(mockSeat, {
      events: [{ webinarId: "web-1", classId: null }],
      upcoming: 1,
      amount: 800_000,
      listPaise: 800_000,
      totalSessions: null,
      sessionsPurchased: null,
      occurrences: [],
    });

    const summary = await ban("learner-user");

    expect(summary.attendeeRemovals).toBe(1);
    expect(mockTransaction.mock.calls.map(([, options]) => options)).toEqual([
      LIMITS,
    ]);
  });
});
