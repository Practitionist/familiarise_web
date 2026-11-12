/**
 * @jest-environment node
 */

/**
 * #1319 — the number the cancel dialog quotes and the number the cancel pays.
 *
 * The preview route exists for exactly one reason: to tell somebody, before
 * they click, what cancelling will return to them. That promise is only worth
 * something if the two agree, and until now nothing checked that they did.
 * Both sides computed the same four steps — notice tier, the booking's policy,
 * per-session proration, clamp to the refundable balance — inline, in two
 * files, with two sets of comments explaining the same reasoning. Two copies of
 * a money rule drift; that is what copies do.
 *
 * #1499 — the tiers are typed rows behind `Appointment.cancellationPolicyId` now,
 * so the fixtures below are stored basis-point ladders rather than Json snapshots.
 * #1500 adds the credit-funded row: its quote is a full restoration on the credits
 * rail, which pays zero gateway money, so the parity assertions branch on what the
 * preview says happens rather than on the amount alone.
 *
 * `quoteBookingRefund` is now the single implementation and both routes call
 * it, but a shared function is only half the guarantee: each route still feeds
 * it, and each route could feed it differently. So this suite drives the real
 * GET and the real POST over one prisma stub and compares the quote the buyer
 * read against the amount `refundBookingPayment` was actually asked for, across
 * a matrix of policy ladders, notice windows, paid amounts and prior partial
 * refunds.
 *
 * The stub models the ordering the database imposes, borrowed from
 * `cancel-route-refund.test.ts`: live slots before the cancel transaction
 * commits, CANCELLED afterwards. The preview therefore has to run first, which
 * is also the only order a real buyer can produce.
 */

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockPaymentFindFirst = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockGetSession = jest.fn();
/** Referral credit the payment still holds consumed (0 for a 100% discount). */
const mockCreditUsage = jest.fn();

/** Flipped by the $transaction stub, mirroring the slot terminalisation. */
let txCommitted = false;

const txStub = {
  // The CAS helpers read the from-status just before the compare-and-set, so
  // every booking model answers a findUnique as well as the updateMany.
  consultation: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  subscription: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  webinar: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  class: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  // #1322 — the participant edge is terminalised and the status history
  // appended inside the same cancel transaction.
  appointmentParticipant: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  referralCreditUsage: {
    aggregate: (...a: unknown[]) => mockCreditUsage(...a),
  },
  // The refund the cancel owes is stamped on the payment in the same commit.
  payment: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
  },
  // #1766 — a subscription cancel stamps the undelivered earnings tranches.
  consultantEarnings: {
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  // No session of the subscription was refunded on its own.
  refund: { findMany: jest.fn().mockResolvedValue([]) },
  // An expert-side cancel of a paid booking writes a reliability strike.
  systemEvent: { create: jest.fn().mockResolvedValue({}) },
  // The consultee's seat revocation commits with the cancel.
  streamRevocationRetry: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  // transitionOccurrenceCompletion reads the from-status, then moves the cohort with
  // updateManyAndReturn so each moved id gets its own history row.
  appointmentOccurrence: {
    findMany: jest.fn().mockResolvedValue([]),
    updateManyAndReturn: jest
      .fn()
      .mockResolvedValue([{ id: "slot-1" }, { id: "slot-2" }]),
  },
  // The cancel route reads the open proposals, then CASes each by id.
  rescheduleRequest: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue({ status: "PENDING_REVIEW" }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  // #1695 — the cancel POST reads the refund context on the tx client, under
  // the lock and before the CAS; the preview GET keeps the global read.
  appointment: {
    findFirst: async (...a: unknown[]) =>
      (await mockAppointmentFindMany(...a))[0] ?? null,
  },
};

jest.mock("next/headers", () => ({ headers: async () => new Headers() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const out = await fn(txStub);
      txCommitted = true;
      return out;
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
      // #1554 — the refund context reads the ONE wrapper.
      findFirst: async (...a: unknown[]) =>
        (await mockAppointmentFindMany(...a))[0] ?? null,
    },
    payment: {
      findMany: (...a: unknown[]) => mockPaymentFindMany(...a),
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // No earlier refund carries the cancel's key, and no session was refunded on its own.
    refund: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // No session of the booking was ever released by a reschedule.
    appointmentOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
    rescheduleRequest: { findMany: jest.fn().mockResolvedValue([]) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
    systemEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    referralCreditUsage: {
      aggregate: (...a: unknown[]) => mockCreditUsage(...a),
    },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

// #1328 put a per-user limiter on the cancel route. This suite cancels the
// same booking as the same user once per case, which is a rate the limiter is
// right to refuse and this suite is not testing.
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  // Only the charge is stubbed. `fundingRailForIntent` stays real, because the
  // rail the preview names is part of what this suite is comparing and a
  // stubbed derivation would only ever agree with itself.
  ...jest.requireActual("../../lib/payments/operations/booking-refund"),
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));

jest.mock("../../lib/payments/operations/event-refunds", () => ({
  stampWholeEventRefundsOwed: jest.fn().mockResolvedValue(new Map()),
  refundWholeEventPayments: jest.fn().mockResolvedValue({
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
  }),
}));

jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
    recordSystemEvent: jest.fn().mockResolvedValue(undefined),
  };
});

import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";
import { GET as previewHandler } from "@/app/api/appointments/[appointmentId]/cancel/preview/route";
import type { RefundTier } from "@/lib/payments/operations/cancellation-policy";

const HOUR = 3_600_000;
const APPT = "appt-1";
const CONSULTANT_USER = "consultant-1";
const CONSULTEE_USER = "consultee-1";
const CONSULTANT_PROFILE = "cp-1";
const CONSULTEE_PROFILE = "ce-1";
const HOST_ORG = "org-host";
const OPERATOR_USER = "operator-1";

/**
 * Both routes read the appointment through their own select, so the stub
 * answers a superset: `requestedBy` carries both the preview's `userId` and the
 * cancel route's nested `user.id`, and likewise for the consultant profile.
 */
function appointmentRow(kind: "consultation" | "subscription") {
  const consultantProfile = {
    userId: CONSULTANT_USER,
    user: { id: CONSULTANT_USER, name: "Dr Who" },
  };
  const requestedBy = {
    userId: CONSULTEE_USER,
    user: { id: CONSULTEE_USER, name: "Ada" },
  };
  const base = {
    id: APPT,
    organizationId: null,
    webinarId: null,
    classId: null,
    webinar: null,
    class: null,
    occurrences: [{ startsAt: new Date(Date.now() + 120 * HOUR) }],
  };

  if (kind === "subscription") {
    return {
      ...base,
      appointmentType: "SUBSCRIPTION",
      consultationId: null,
      subscriptionId: "sub-1",
      consultation: null,
      subscription: {
        id: "sub-1",
        requestedById: CONSULTEE_PROFILE,
        requestedBy,
        subscriptionPlan: {
          title: "Monthly plan",
          consultantProfileId: CONSULTANT_PROFILE,
          organizationId: HOST_ORG,
          consultantProfile,
        },
      },
    };
  }

  return {
    ...base,
    appointmentType: "CONSULTATION",
    consultationId: "cons-1",
    subscriptionId: null,
    subscription: null,
    consultation: {
      id: "cons-1",
      requestedById: CONSULTEE_PROFILE,
      requestedBy,
      consultationPlan: {
        title: "Strategy call",
        consultantProfileId: CONSULTANT_PROFILE,
        organizationId: HOST_ORG,
        consultantProfile,
      },
    },
  };
}

/** A stored policy version, in the shape `POLICY_TERMS_INCLUDE` selects. */
type PolicyFixture = {
  tiers: RefundTier[];
  consultantInitiatedPct?: number;
  organizationId?: string | null;
};

function policyRow(policy: PolicyFixture) {
  return {
    id: "policy-1",
    organizationId: policy.organizationId ?? null,
    version: 1,
    consultantInitiatedBps: Math.round(
      (policy.consultantInitiatedPct ?? 100) * 100,
    ),
    tiers: [...policy.tiers]
      .sort((a, b) => b.hoursBefore - a.hoursBefore)
      .map((tier) => ({
        hoursBefore: tier.hoursBefore,
        refundBps: Math.round(tier.refundPct * 100),
      })),
  };
}

type Case = {
  name: string;
  kind: "consultation" | "subscription";
  policy: PolicyFixture | null;
  /** Defaults to a gateway intent; `free_` drives the #1500 credit rail. */
  paymentIntent?: string;
  /** Hours until each undelivered session. */
  liveSlotHours: number[];
  /** Hours (negative = past) of each already-delivered session. */
  completedSlotHours?: number[];
  grossPaise: number;
  priorRefundPaise?: number;
  actor: "consultee" | "consultant" | "operator";
};

/** The booking as the database answers it, before and after the cancel tx. */
function bookingRows(c: Case) {
  const live = c.liveSlotHours.map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    endsAt: new Date(Date.now() + (h + 1) * HOUR),
    ordinal: 1,
    completionStatus: txCommitted ? "CANCELLED" : "SCHEDULED",
  }));
  const done = (c.completedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    endsAt: new Date(Date.now() + (h + 1) * HOUR),
    ordinal: 1,
    completionStatus: "COMPLETED",
  }));
  return [
    {
      id: APPT,
      cancellationPolicy: c.policy ? policyRow(c.policy) : null,
      payment: [
        {
          id: "pay-1",
          amount: c.grossPaise,
          paymentIntent: c.paymentIntent ?? "pi_gateway_1",
          refunds: c.priorRefundPaise
            ? [{ amountPaise: c.priorRefundPaise, status: "SUCCEEDED" }]
            : [],
          disputes: [],
        },
      ],
      occurrences: [...done, ...live],
      // #1766 — the plan entitlement; every fixture's plan is exactly the
      // sessions it holds, so the unused-session quote and the old
      // allocated-slot proration agree on the base.
      subscription:
        c.kind === "subscription"
          ? {
              sessionsTotal: done.length + live.length,
              subscriptionPlan: { totalSessions: 0 },
            }
          : null,
    },
  ];
}

function sessionAs(role: "consultee" | "consultant" | "operator") {
  if (role === "operator") {
    return {
      user: {
        id: OPERATOR_USER,
        name: "Ops",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    };
  }
  return {
    user:
      role === "consultant"
        ? {
            id: CONSULTANT_USER,
            name: "Dr Who",
            consultantProfileId: CONSULTANT_PROFILE,
            consulteeProfileId: null,
          }
        : {
            id: CONSULTEE_USER,
            name: "Ada",
            consultantProfileId: null,
            consulteeProfileId: CONSULTEE_PROFILE,
          },
  };
}

function makeParams(id: string) {
  return { params: Promise.resolve({ appointmentId: id }) };
}

/** The tiers a platform-default booking is quoted against. */
const DEFAULT_POLICY: PolicyFixture = {
  tiers: [
    { hoursBefore: 24, refundPct: 100 },
    { hoursBefore: 2, refundPct: 50 },
    { hoursBefore: 0, refundPct: 0 },
  ],
};

/** A stricter org-published ladder: nothing is ever fully refundable. */
const STRICT_POLICY: PolicyFixture = {
  organizationId: "org-1",
  tiers: [
    { hoursBefore: 72, refundPct: 80 },
    { hoursBefore: 24, refundPct: 40 },
    { hoursBefore: 0, refundPct: 10 },
  ],
};

/**
 * A two-step ladder whose thresholds arrive out of order. The store orders tiers
 * on read, so this fixture skips that ordering deliberately: `computeRefundPct`
 * sorts for itself, and a caller that hands it raw rows must still be quoted right.
 */
const UNSORTED_POLICY: PolicyFixture = {
  organizationId: "org-1",
  tiers: [
    { hoursBefore: 1, refundPct: 25 },
    { hoursBefore: 48, refundPct: 90 },
  ],
};

const CASES: Case[] = [
  {
    name: "platform default, five days out, whole price",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    liveSlotHours: [120],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "platform default, six hours out, mid tier",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    liveSlotHours: [6],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "platform default, inside the final two hours",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    liveSlotHours: [1],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "no policy row at all falls back to the platform tiers",
    kind: "consultation",
    policy: null,
    liveSlotHours: [6],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "consultant-initiated inside the zero tier still refunds in full",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    liveSlotHours: [1],
    grossPaise: 500_000,
    actor: "consultant",
  },
  {
    name: "strict org tiers, four days out",
    kind: "consultation",
    policy: STRICT_POLICY,
    liveSlotHours: [96],
    grossPaise: 333_333,
    actor: "consultee",
  },
  {
    name: "strict org tiers, thirty hours out",
    kind: "consultation",
    policy: STRICT_POLICY,
    liveSlotHours: [30],
    grossPaise: 333_333,
    actor: "consultee",
  },
  {
    name: "strict org tiers, inside the day, never fully unrefundable",
    kind: "consultation",
    policy: STRICT_POLICY,
    liveSlotHours: [3],
    grossPaise: 333_333,
    actor: "consultee",
  },
  {
    name: "unsorted tiers resolve to the highest threshold cleared",
    kind: "consultation",
    policy: UNSORTED_POLICY,
    liveSlotHours: [50],
    grossPaise: 250_000,
    actor: "consultee",
  },
  {
    name: "a prior partial refund clamps the remainder",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    liveSlotHours: [120],
    grossPaise: 500_000,
    priorRefundPaise: 200_000,
    actor: "consultee",
  },
  {
    name: "a prior partial refund below the tiered amount is untouched",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    liveSlotHours: [6],
    grossPaise: 500_000,
    priorRefundPaise: 100_000,
    actor: "consultee",
  },
  {
    name: "a subscription half consumed prorates the base",
    kind: "subscription",
    policy: DEFAULT_POLICY,
    liveSlotHours: [120, 300, 480],
    completedSlotHours: [-200, -100, -50],
    grossPaise: 900_000,
    actor: "consultee",
  },
  {
    name: "a subscription prorating to an indivisible base rounds down",
    kind: "subscription",
    policy: STRICT_POLICY,
    liveSlotHours: [96, 200],
    completedSlotHours: [-10],
    grossPaise: 100_001,
    actor: "consultee",
  },
  {
    name: "a prorated subscription also clamped by a prior refund",
    kind: "subscription",
    policy: DEFAULT_POLICY,
    liveSlotHours: [120, 300],
    completedSlotHours: [-40, -20],
    grossPaise: 800_000,
    priorRefundPaise: 350_000,
    actor: "consultee",
  },
  {
    name: "a subscription with every session still owed refunds the whole price",
    kind: "subscription",
    policy: DEFAULT_POLICY,
    liveSlotHours: [120, 300, 480, 600],
    grossPaise: 640_000,
    actor: "consultee",
  },
  {
    // #1500 — six hours out is the 50% rung, and a credit cannot be halved, so the
    // quote and the charge both settle at a full restoration of zero gateway paise.
    name: "a credit-funded booking inside a partial tier restores the credit in full",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    paymentIntent: "free_credit_1",
    liveSlotHours: [6],
    grossPaise: 0,
    actor: "consultee",
  },
  {
    // #1500 — and the 0% rung still returns nothing, exactly as it does for a card.
    name: "a credit-funded booking inside the zero tier restores nothing",
    kind: "consultation",
    policy: DEFAULT_POLICY,
    paymentIntent: "free_credit_1",
    liveSlotHours: [1],
    grossPaise: 0,
    actor: "consultee",
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  txCommitted = false;
  txStub.consultation.updateMany.mockResolvedValue({ count: 1 });
  txStub.subscription.updateMany.mockResolvedValue({ count: 1 });
  txStub.appointmentOccurrence.findMany.mockResolvedValue([]);
  txStub.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
    { id: "slot-1" },
    { id: "slot-2" },
  ]);
  txStub.rescheduleRequest.findMany.mockResolvedValue([]);
  mockCreditUsage.mockResolvedValue({ _sum: { amount: 50_000 } });
  mockPaymentFindMany.mockResolvedValue([]);
  mockPaymentFindFirst.mockResolvedValue({
    currency: "INR",
    paymentIntent: "pi_gateway_1",
  });
  // The credits rail refuses an amount and restores the whole credit, so it reports
  // zero paise moved — which is why the parity assertions below read the status.
  mockRefundBookingPayment.mockImplementation(
    async ({ amountPaise }: { amountPaise?: number }) =>
      amountPaise === undefined
        ? { refundId: "r1", amountRefundedPaise: 0, rail: "CREDITS" }
        : { refundId: "r1", amountRefundedPaise: amountPaise, rail: "GATEWAY" },
  );
});

/** Quote it, then cancel it, in that order — the only order a buyer can make. */
async function quoteThenCancel(c: Case) {
  mockGetSession.mockResolvedValue(sessionAs(c.actor));
  mockAppointmentFindUnique.mockResolvedValue(appointmentRow(c.kind));
  mockAppointmentFindMany.mockImplementation(async () => bookingRows(c));
  // The preview names the rail off its own payment lookup, so it has to see the
  // same intent the booking rows carry.
  mockPaymentFindFirst.mockResolvedValue({
    currency: "INR",
    paymentIntent: c.paymentIntent ?? "pi_gateway_1",
  });

  const previewRes = await previewHandler(
    new Request(`http://localhost/api/appointments/${APPT}/cancel/preview`),
    makeParams(APPT),
  );
  const preview = await previewRes.json();

  const cancelRes = await cancelHandler(
    new Request(`http://localhost/api/appointments/${APPT}/cancel`, {
      method: "POST",
    }) as never,
    makeParams(APPT),
  );
  const cancelled = await cancelRes.json();

  return { previewRes, preview, cancelRes, cancelled };
}

describe("the cancel preview quotes what the cancel actually pays", () => {
  it.each(CASES)("$name", async (c) => {
    const { previewRes, preview, cancelRes, cancelled } =
      await quoteThenCancel(c);

    expect(previewRes.status).toBe(200);
    expect(cancelRes.status).toBe(200);

    // The tier the buyer was shown is the tier they were charged.
    expect(preview.refundPct).toBe(cancelled.refund.refundPct);

    // And the number, which is the whole point.
    expect(preview.estimatedRefundPaise).toBe(
      cancelled.refund.amountRefundedPaise,
    );

    // A zero quote is a promise too: nothing is paid and nothing is attempted.
    // Reading the calls off the mock rather than branching keeps this one
    // assertion for both outcomes.
    const calls = mockRefundBookingPayment.mock.calls.map(([arg]) => ({
      paymentId: (arg as { paymentId: string }).paymentId,
      amountPaise: (arg as { amountPaise?: number }).amountPaise,
    }));
    // #1500 — a full credit restoration is issued with NO amount, because the
    // credits rail refuses a partial one. Everything else pays exactly the quote.
    expect(calls).toEqual(
      preview.creditRestoresInFull
        ? [{ paymentId: "pay-1", amountPaise: undefined }]
        : preview.estimatedRefundPaise > 0
          ? [{ paymentId: "pay-1", amountPaise: preview.estimatedRefundPaise }]
          : [],
    );

    // The route's own outcomes: paid, restored in full, or one of the two
    // different zeros.
    expect(cancelled.refund.status).toBe(
      preview.creditRestoresInFull || preview.estimatedRefundPaise > 0
        ? "REFUNDED"
        : preview.refundPct > 0
          ? "NOTHING_REFUNDABLE"
          : "POLICY_ZERO",
    );
  });
});

describe("the quote's own numbers hold up", () => {
  it("prorates a half-consumed subscription and says so", async () => {
    const c = CASES.find((x) => x.name.startsWith("a subscription half"))!;
    const { preview } = await quoteThenCancel(c);

    // Three of six sessions still owed, 100% tier: ₹9,000 × 3/6.
    expect(preview.prorated).toBe(true);
    expect(preview.refundPct).toBe(100);
    expect(preview.estimatedRefundPaise).toBe(450_000);
  });

  it("does not call a fully undelivered subscription prorated", async () => {
    const c = CASES.find((x) =>
      x.name.startsWith("a subscription with every"),
    )!;
    const { preview } = await quoteThenCancel(c);

    expect(preview.prorated).toBe(false);
    expect(preview.estimatedRefundPaise).toBe(640_000);
  });

  it("clamps to the balance left after an earlier partial refund", async () => {
    const c = CASES.find((x) => x.name.startsWith("a prior partial"))!;
    const { preview } = await quoteThenCancel(c);

    // 100% of ₹5,000 is ₹5,000, but ₹2,000 has already gone back.
    expect(preview.refundPct).toBe(100);
    expect(preview.estimatedRefundPaise).toBe(300_000);
  });

  it("reads a booking with no session ever scheduled as full notice", async () => {
    const c: Case = {
      name: "never scheduled",
      kind: "subscription",
      policy: DEFAULT_POLICY,
      liveSlotHours: [],
      grossPaise: 500_000,
      actor: "consultee",
    };
    const { preview, cancelled } = await quoteThenCancel(c);

    // No slot ever existed, so the buyer has infinite notice — not the "already
    // started" floor — and both sides must agree on that reading.
    expect(preview.refundPct).toBe(100);
    expect(preview.estimatedRefundPaise).toBe(500_000);
    expect(cancelled.refund.amountRefundedPaise).toBe(500_000);
  });
});

const prismaMock = jest.requireMock("../../lib/prisma").default as {
  membership: { findUnique: jest.Mock };
};

describe("preview and POST share one cancel actor", () => {
  afterEach(() => {
    prismaMock.membership.findUnique.mockResolvedValue(null);
  });

  it("a host-org operator is quoted and charged at the consultant tier", async () => {
    prismaMock.membership.findUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
      organization: { status: "ACTIVE" },
    });
    const { previewRes, preview, cancelRes, cancelled } = await quoteThenCancel(
      {
        name: "host-org operator inside the zero tier",
        kind: "consultation",
        policy: DEFAULT_POLICY,
        liveSlotHours: [1],
        grossPaise: 500_000,
        actor: "operator",
      },
    );
    expect(previewRes.status).toBe(200);
    expect(preview.refundPct).toBe(100);
    expect(cancelRes.status).toBe(200);
    expect(cancelled.refund.amountRefundedPaise).toBe(
      preview.estimatedRefundPaise,
    );
  });

  it("a stranger is refused by both", async () => {
    const { previewRes, cancelRes } = await quoteThenCancel({
      name: "no relation to the booking",
      kind: "consultation",
      policy: DEFAULT_POLICY,
      liveSlotHours: [48],
      grossPaise: 500_000,
      actor: "operator",
    });
    expect(previewRes.status).toBe(403);
    expect(cancelRes.status).toBe(403);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});

describe("the cancel window refuses at both doors", () => {
  it.each([
    ["a session starting in ten minutes", [10 / 60], [], "SESSION_IN_PROGRESS"],
    ["a session under way", [-0.5], [], "SESSION_IN_PROGRESS"],
    [
      "a held session with nothing ahead",
      [],
      [-3],
      "SESSION_ALREADY_DELIVERED",
    ],
  ])("%s", async (_label, liveSlotHours, completedSlotHours, code) => {
    const { previewRes, preview, cancelRes, cancelled } = await quoteThenCancel(
      {
        name: String(_label),
        kind: "consultation",
        policy: DEFAULT_POLICY,
        liveSlotHours,
        completedSlotHours,
        grossPaise: 500_000,
        actor: "consultee",
      },
    );
    expect(previewRes.status).toBe(409);
    expect(preview.code).toBe(code);
    expect(cancelRes.status).toBe(409);
    expect(cancelled.code).toBe(code);
    expect(txStub.consultation.updateMany).not.toHaveBeenCalled();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("the consultant cannot cancel a held session either", async () => {
    const { cancelRes, cancelled } = await quoteThenCancel({
      name: "consultant after delivery",
      kind: "consultation",
      policy: DEFAULT_POLICY,
      liveSlotHours: [],
      completedSlotHours: [-3],
      grossPaise: 500_000,
      actor: "consultant",
    });
    expect(cancelRes.status).toBe(409);
    expect(cancelled.code).toBe("SESSION_ALREADY_DELIVERED");
  });
});

describe("the cancel owns the refund it drives", () => {
  it("refuses with nothing committed when another door's refund is still owed", async () => {
    // The owed-marker stamp is the only payment updateMany in the cancel tx.
    txStub.payment.updateMany.mockResolvedValueOnce({ count: 0 });
    const { cancelRes, cancelled } = await quoteThenCancel({
      name: "marker held by another door",
      kind: "consultation",
      policy: DEFAULT_POLICY,
      liveSlotHours: [48],
      grossPaise: 500_000,
      actor: "consultee",
    });
    expect(cancelRes.status).toBe(409);
    expect(cancelled.code).toBe("REFUND_IN_PROGRESS");
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("names support, once, when the held marker has spent its attempts", async () => {
    const events = jest.requireMock("../../lib/enterprise/system-events") as {
      recordSystemEvent: jest.Mock;
    };
    const standing = jest.requireMock("../../lib/prisma").default as {
      systemEvent: { findFirst: jest.Mock };
    };
    txStub.payment.updateMany.mockResolvedValue({ count: 0 });
    txStub.payment.findUnique.mockResolvedValue({
      refundOwedKey: "incident:inc-1:occ-1:user-1",
      refundOwedAttempts: 3,
      disputes: [],
    });
    const c: Case = {
      name: "stuck marker",
      kind: "consultation",
      policy: DEFAULT_POLICY,
      liveSlotHours: [48],
      grossPaise: 500_000,
      actor: "consultee",
    };
    const first = await quoteThenCancel(c);
    expect(first.cancelRes.status).toBe(409);
    expect(first.cancelled.code).toBe("REFUND_NEEDS_SUPPORT");
    expect(events.recordSystemEvent).toHaveBeenCalledTimes(1);
    expect(events.recordSystemEvent.mock.calls[0][0].correlationId).toBe(
      "refund-needs-support:pay-1:incident:inc-1:occ-1:user-1",
    );

    standing.systemEvent.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    txCommitted = false;
    const again = await quoteThenCancel(c);
    expect(again.cancelled.code).toBe("REFUND_NEEDS_SUPPORT");
    expect(events.recordSystemEvent).toHaveBeenCalledTimes(1);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();

    txStub.payment.updateMany.mockResolvedValue({ count: 1 });
    txStub.payment.findUnique.mockResolvedValue(null);
  });

  it("stamps a zero-refund subscription's tranches inside the cancel transaction", async () => {
    let stampedInTx = false;
    txStub.consultantEarnings.findMany.mockImplementationOnce(async () => {
      stampedInTx = !txCommitted;
      return [];
    });
    const { cancelRes, cancelled } = await quoteThenCancel({
      name: "subscription inside the zero tier",
      kind: "subscription",
      policy: DEFAULT_POLICY,
      liveSlotHours: [1],
      grossPaise: 500_000,
      actor: "consultee",
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelled.refund.status).toBe("POLICY_ZERO");
    expect(stampedInTx).toBe(true);
  });
});

describe("a credit-funded plan cancelled after delivery goes to review", () => {
  it("previews the review, queues it in the cancel commit and holds no tranche", async () => {
    const events = jest.requireMock("../../lib/enterprise/system-events") as {
      recordSystemEvent: jest.Mock;
    };
    const { preview, cancelRes, cancelled } = await quoteThenCancel({
      name: "credit plan after delivery",
      kind: "subscription",
      policy: DEFAULT_POLICY,
      paymentIntent: "free_1730000000_sub",
      liveSlotHours: [48],
      completedSlotHours: [-48],
      grossPaise: 0,
      actor: "consultee",
    });
    expect(preview.creditReturnNeedsReview).toBe(true);
    expect(preview.creditRestoresInFull).toBe(false);
    expect(cancelRes.status).toBe(200);
    expect(cancelled.refund).toMatchObject({
      status: "PENDING",
      requiresManualReview: true,
    });
    expect(events.recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "partial-credit:pay-1" }),
    );
    expect(txStub.consultantEarnings.findMany).not.toHaveBeenCalled();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("a plan paid by a 100% discount has no credit to return: no review, tranches held", async () => {
    mockCreditUsage.mockResolvedValue({ _sum: { amount: null } });
    const events = jest.requireMock("../../lib/enterprise/system-events") as {
      recordSystemEvent: jest.Mock;
    };
    const { preview, cancelRes, cancelled } = await quoteThenCancel({
      name: "discount-only plan after delivery",
      kind: "subscription",
      policy: DEFAULT_POLICY,
      paymentIntent: "free_1730000000_sub",
      liveSlotHours: [48],
      completedSlotHours: [-48],
      grossPaise: 0,
      actor: "consultee",
    });
    expect(preview.creditReturnNeedsReview).toBe(false);
    expect(cancelRes.status).toBe(200);
    expect(cancelled.refund?.requiresManualReview).toBeUndefined();
    expect(events.recordSystemEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "partial-credit:pay-1" }),
    );
    expect(txStub.consultantEarnings.findMany).toHaveBeenCalled();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});
