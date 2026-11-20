/**
 * @jest-environment node
 */

/**
 * The cancel route must actually refund. There was no test that it did.
 *
 * Both existing cancel-route suites stub the wrapper read to nothing, which
 * makes the payment lookup come back empty and kills the entire refund block —
 * so every check on those suites was compatible with the refund path being
 * dead. It was: resolving the booking context AFTER the cancel transaction
 * meant the transaction had already stamped every SCHEDULED/RESCHEDULED slot
 * CANCELLED, the "next undelivered session" came back empty, and every
 * consultee-initiated cancellation silently fell to the 0% tier.
 *
 * The prisma stub here models that ordering honestly: the wrapper read
 * answers with live slots before `$transaction` runs and with CANCELLED slots
 * afterwards, exactly as the database would. A resolver called on the wrong
 * side of the transaction therefore scores 0% and these tests fail.
 */

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockOrgFundingPayment = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockRecordSystemError = jest.fn();
const mockGetSession = jest.fn();
const mockMembershipFindUnique = jest.fn();

/** The committed request a retried click reads back. */
const mockConsultationFindUnique = jest.fn();
const globalAppointmentFindFirst = jest.fn(
  async (...a: unknown[]) => (await mockAppointmentFindMany(...a))[0] ?? null,
);

/** Flipped by the $transaction stub, mirroring the slot terminalisation. */
let txCommitted = false;

const txStub = {
  consultation: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
  },
  subscription: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
  },
  webinar: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  class: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  appointmentParticipant: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  // The refund the cancel owes is stamped on the payment in the same commit.
  payment: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  // #1766 — a subscription cancel stamps the undelivered earnings tranches in
  // the same transaction.
  consultantEarnings: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  // No session of a subscription was refunded on its own.
  refund: { findMany: jest.fn().mockResolvedValue([]) },
  // An expert-side cancel of a paid booking writes a reliability strike.
  systemEvent: { create: jest.fn().mockResolvedValue({}) },
  streamRevocationRetry: createMockRevocationRetryTable(),
  // #1851 decision 2 — an act-for-org cancel writes the org's audit row.
  orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
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
  // #1695 — the refund context is read on the TRANSACTION client, under the
  // appointment lock and before the CAS, so it still sees live slots.
  appointment: {
    findFirst: jest.fn(
      async (...a: unknown[]) =>
        (await mockAppointmentFindMany(...a))[0] ?? null,
    ),
  },
};

jest.mock("next/headers", () => ({ headers: async () => new Headers() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const out = await fn(txStub);
      // The cancel transaction terminalises every live slot. Anything reading
      // "which session is still owed" after this point sees nothing.
      txCommitted = true;
      return out;
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
      // #1554 — the refund context reads the ONE wrapper; #1695 moved that
      // read onto the tx client, so this one must stay silent.
      findFirst: (...a: unknown[]) => globalAppointmentFindFirst(...a),
    },
    payment: {
      findMany: (...a: unknown[]) => mockPaymentFindMany(...a),
      // The org actor's funding proof (lib/booking/org-actor.ts): the booking's
      // OWN payment row, keyed on the org. Distinct from the refund-quote read
      // above, which is why it is a separate mock rather than a shared one.
      findFirst: (...a: unknown[]) => mockOrgFundingPayment(...a),
      // The drive clears or counts the owed marker by CAS.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // The reserved row a gateway throw leaves behind; no earlier
    // refund carries the cancel's key.
    refund: {
      findUnique: jest.fn(async (args: { where: { dedupeKey?: string } }) =>
        args.where.dedupeKey ? null : { status: "PENDING" },
      ),
    },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    consultation: {
      findUnique: (...a: unknown[]) => mockConsultationFindUnique(...a),
    },
    // #1166 — what `isOrgAdminOfAppointment` reads.
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: jest.fn(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  ),
  renewAppointmentLock: jest.fn(async () => undefined),
  withEventCheckoutLock: jest.fn(
    async (
      _key: unknown,
      fn: (renew: () => Promise<void>) => Promise<unknown>,
    ) => fn(async () => undefined),
  ),
  BookingLockUnavailableError: class extends Error {},
  AppointmentBusyError: class extends Error {},
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
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
  return {
    recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
    recordSystemErrorSafe: (...a: unknown[]) => mockRecordSystemError(...a),
  };
});

import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";
import { RefundGatewayError } from "@/lib/payments/operations/refund";
import { grantPlatformCancel } from "@/lib/booking/platform-cancel";
import { refundNoticeKind } from "@/lib/payments/operations/refund-cause";
import { createMockRevocationRetryTable } from "../fixtures/stream-mocks";
import { notifyAppointmentCancelled } from "@/lib/novu";

const HOUR = 3_600_000;
const APPT = "appt-1";
const CONSULTANT_USER = "consultant-1";
const CONSULTEE_USER = "consultee-1";
const CONSULTANT_PROFILE = "cp-1";
const CONSULTEE_PROFILE = "ce-1";

/** ₹5,000. */
const GROSS = 500_000;

function makeParams(id: string) {
  return { params: Promise.resolve({ appointmentId: id }) };
}

function makeRequest(body?: Record<string, unknown>) {
  return new Request(`http://localhost/api/appointments/${APPT}/cancel`, {
    method: "POST",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  }) as never;
}

function consultationAppointment() {
  return {
    id: APPT,
    appointmentType: "CONSULTATION",
    organizationId: null,
    consultationId: "cons-1",
    subscriptionId: null,
    cancellationPolicy: null,
    occurrences: [{ startsAt: new Date(Date.now() + 120 * HOUR) }],
    consultation: {
      id: "cons-1",
      requestedById: CONSULTEE_PROFILE,
      consultationPlan: {
        title: "Strategy call",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
      requestedBy: { user: { id: CONSULTEE_USER, name: "Ada" } },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function subscriptionAppointment() {
  return {
    ...consultationAppointment(),
    appointmentType: "SUBSCRIPTION",
    consultationId: null,
    subscriptionId: "sub-1",
    consultation: null,
    subscription: {
      id: "sub-1",
      requestedById: CONSULTEE_PROFILE,
      subscriptionPlan: {
        title: "Monthly plan",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
      requestedBy: { user: { id: CONSULTEE_USER, name: "Ada" } },
    },
  };
}

/**
 * The booking as the database would answer it: live slots until the cancel
 * transaction commits, terminalised afterwards.
 */
function bookingRows(opts: {
  liveSlotHours?: number[];
  completedSlotHours?: number[];
  /** Sessions terminalised BEFORE this cancellation — a session the plan held. */
  cancelledSlotHours?: number[];
  /** Past sessions with no Meeting row (offline, most likely held). */
  unverifiedSlotHours?: number[];
  paymentRefunds?: { amountPaise: number; status: string }[];
  noPayment?: boolean;
  /** Defaults to a gateway-funded payment. */
  paymentAmount?: number;
  paymentIntent?: string;
  /** The plan price before discounts and credits; zero on a free booking. */
  listPricePaise?: number;
  /**
   * #1766 — the plan entitlement the unused-session quote measures against.
   * Defaults to every slot the fixture holds, which is the pre-Z2 denominator.
   */
  sessionsTotal?: number;
}) {
  const live = (opts.liveSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    endsAt: new Date(Date.now() + (h + 1) * HOUR),
    ordinal: 1,
    completionStatus: txCommitted ? "CANCELLED" : "SCHEDULED",
  }));
  const done = (opts.completedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    endsAt: new Date(Date.now() + (h + 1) * HOUR),
    ordinal: 1,
    completionStatus: "COMPLETED",
  }));
  const gone = (opts.cancelledSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    endsAt: new Date(Date.now() + (h + 1) * HOUR),
    ordinal: 1,
    completionStatus: "CANCELLED",
  }));
  const unverified = (opts.unverifiedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    endsAt: new Date(Date.now() + (h + 1) * HOUR),
    ordinal: 1,
    completionStatus: "UNVERIFIED",
  }));
  return [
    {
      id: APPT,
      cancellationPolicy: null,
      payment: opts.noPayment
        ? []
        : [
            {
              id: "pay-1",
              amount: opts.paymentAmount ?? GROSS,
              originalAmount: opts.listPricePaise ?? GROSS,
              paymentIntent: opts.paymentIntent ?? "pi_gateway_1",
              refunds: opts.paymentRefunds ?? [],
              disputes: [],
            },
          ],
      occurrences: [...done, ...gone, ...unverified, ...live],
      subscription: {
        sessionsTotal:
          opts.sessionsTotal ??
          done.length + gone.length + unverified.length + live.length,
        subscriptionPlan: { totalSessions: 0 },
      },
    },
  ];
}

function sessionAs(role: "consultant" | "consultee" | "admin") {
  if (role === "admin") {
    return {
      user: {
        id: "admin-1",
        name: "Ops",
        role: "ADMIN",
        twoFactorEnabled: true,
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
  mockPaymentFindMany.mockResolvedValue([]);
  mockConsultationFindUnique.mockResolvedValue(null);
  // No org funding proof by default: the participant paths never ask.
  mockOrgFundingPayment.mockResolvedValue(null);
  mockMembershipFindUnique.mockResolvedValue(null);
  mockRecordSystemError.mockResolvedValue(undefined);
  mockRefundBookingPayment.mockImplementation(
    async ({ amountPaise }: { amountPaise: number }) => ({
      refundId: "r1",
      amountRefundedPaise: amountPaise,
      rail: "GATEWAY",
    }),
  );
});

describe("a consultee cancelling a paid consultation gets their money back", () => {
  it("refunds the full amount five days out", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    // The regression: resolved after the transaction this was 0. The rail
    // rides along so the confirmation can name where the money went rather
    // than promising a card nobody charged (defect 1).
    expect(body.refund).toEqual({
      amountRefundedPaise: GROSS,
      refundPct: 100,
      status: "REFUNDED",
      rail: "GATEWAY",
    });
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1", amountPaise: GROSS }),
    );
  });

  it("applies the mid-tier inside the day", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [6] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(50);
    expect(body.refund.amountRefundedPaise).toBe(GROSS / 2);
  });

  it("refunds nothing inside the final two hours", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund).toEqual({
      amountRefundedPaise: 0,
      refundPct: 0,
      status: "POLICY_ZERO",
    });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("clamps to what is still refundable after an earlier partial refund", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        liveSlotHours: [120],
        paymentRefunds: [{ amountPaise: 200_000, status: "SUCCEEDED" }],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 100% of gross would exceed the balance, the operation would reject the
    // whole request, and the buyer would get nothing instead of the remainder.
    expect(body.refund.amountRefundedPaise).toBe(GROSS - 200_000);
  });
});

describe("a consultant cancelling always refunds in full", () => {
  it("ignores the clock", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultant"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
    // D10 — the expert's cancel of a paid booking is one strike, in the cancel's transaction.
    expect(txStub.systemEvent.create).toHaveBeenCalledTimes(1);
    expect(txStub.systemEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: `expert-reliability:${CONSULTANT_PROFILE}`,
      }),
    });
  });
});

describe("an expert's cancel of a free confirmed booking", () => {
  it("records a strike though no payment exists", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultant"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [48], noPayment: true }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(200);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(txStub.systemEvent.create).toHaveBeenCalledTimes(1);
  });

  it("writes no refund record for a free checkout booking and still strikes", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultant"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        liveSlotHours: [48],
        paymentAmount: 0,
        listPricePaise: 0,
        paymentIntent: "free_1",
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(txStub.payment.updateMany).not.toHaveBeenCalled();
    expect(body.refund).toMatchObject({ amountRefundedPaise: 0 });
    expect(body.refund.rail).toBeUndefined();
    expect(txStub.systemEvent.create).toHaveBeenCalledTimes(1);
    // Both sides still hear about the cancellation; only the refund notice is dropped.
    expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
      expect.arrayContaining([CONSULTANT_USER]),
      expect.objectContaining({ appointmentId: APPT }),
      expect.objectContaining({
        required: expect.objectContaining({ kind: "CANCELLED_BY_HOST" }),
      }),
    );
    expect(
      (notifyAppointmentCancelled as jest.Mock).mock.calls[0][0],
    ).toHaveLength(2);
  });
});

describe("a platform cancellation is not the buyer's choice", () => {
  it("settles an admin cancellation at the consultant tier", async () => {
    // Requiring the actor to BE the consultant meant an admin cancelling in
    // the final hours settled a buyer who never asked at 0%, while
    // cancel-user-engagements.ts settles the same platform act at 100%.
    mockGetSession.mockResolvedValue(sessionAs("admin"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const request = makeRequest();
    grantPlatformCancel(request, "ops-1");
    const res = await cancelHandler(request, makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
    expect(txStub.systemEvent.create).not.toHaveBeenCalled();
    // Staff ended the booking: both parties hear it, and its refund, whatever their switches say.
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/, staff-initiated\)$/),
      }),
    );
    const [recipients, , opts] = (notifyAppointmentCancelled as jest.Mock).mock
      .calls[0];
    expect(opts).toEqual({
      required: { kind: "CANCELLED_BY_STAFF", recipients },
    });
    expect(recipients).toEqual(
      expect.arrayContaining([CONSULTANT_USER, CONSULTEE_USER]),
    );
  });

  it("a staff member cancelling their own booking stays behind their switches", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        ...sessionAs("consultee").user,
        role: "ADMIN",
        twoFactorEnabled: true,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(200);
    expect((notifyAppointmentCancelled as jest.Mock).mock.calls[0][2]).toBe(
      undefined,
    );
  });

  it("refuses an operator who is not a party unless the audited platform door sent the request", async () => {
    mockGetSession.mockResolvedValue(sessionAs("admin"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PLATFORM_CANCEL_DOOR_REQUIRED");
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});

describe("subscriptions", () => {
  it("refunds an untouched plan on the next session's tier", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [72, 96, 120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });

  it("refunds a paid but never-allocated plan in full", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () => bookingRows({}));

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // No session was ever scheduled, so notice is infinite, not negative.
    // Treating it as negative made cancelling EARLIER score worse than later.
    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });

  it("prorates a partly-consumed plan to the undelivered share (#1006)", async () => {
    // This case used to escalate to MANUAL_REVIEW and refund ₹0, which killed
    // the remaining sessions while returning nothing. #1006 replaced the
    // escalation with the linear rule: the base is the undelivered share, and
    // the frozen policy tier applies to that base.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ completedSlotHours: [-48], liveSlotHours: [72, 96] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 1 of 3 delivered, next session 72h out, so the 100% tier applies to
    // two-thirds of the price: floor(500000 × 2/3) = 333333.
    const undeliveredShare = Math.floor((GROSS * 2) / 3);
    expect(body.refund.status).toBe("REFUNDED");
    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(undeliveredShare);
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: undeliveredShare }),
    );
    // The rule is agreed now, so nothing is owed to an ops queue.
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("measures the undelivered share against the WHOLE plan, not the surviving part", async () => {
    // A session cancelled earlier still belongs to the plan the buyer bought.
    // Summing only completed + live drops it out of the denominator, and the
    // remaining share is then measured against a plan that has shrunk.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        completedSlotHours: [-48],
        cancelledSlotHours: [-24],
        liveSlotHours: [72, 96],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 4 sessions bought, 1 delivered: the cancelled session went back to the
    // entitlement (#1766 — no consumed counter), so THREE are owed, two on the
    // calendar at the 100% tier and one never scheduled at full notice. The
    // plan is the denominator: 3/4 of the price, never 2/3 of a shrunken one.
    expect(body.refund.amountRefundedPaise).toBe((GROSS * 3) / 4);
    expect(body.refund.amountRefundedPaise).not.toBe(
      Math.floor((GROSS * 2) / 3),
    );
  });

  it("counts an unverified past session as delivered, not as owed", async () => {
    // UNVERIFIED is "past, no Meeting row" — an offline session that most
    // likely happened. It is neither COMPLETED nor live, so a completed+live
    // denominator made a 30%-consumed plan score 7/7 and refund the whole price.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        unverifiedSlotHours: [-72, -48, -24],
        liveSlotHours: [72, 96, 120, 144, 168, 192, 216],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(Math.floor((GROSS * 7) / 10));
    expect(body.refund.amountRefundedPaise).not.toBe(GROSS);
  });

  it("leaves a session awaiting review as it is when the plan is cancelled", async () => {
    // The quote counted it delivered; cancelling it would take it off the
    // review list before anyone decided whether it took place.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        unverifiedSlotHours: [-72],
        liveSlotHours: [72, 96],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    expect(res.status).toBe(200);

    const sweeps =
      txStub.appointmentOccurrence.updateManyAndReturn.mock.calls.filter(
        ([call]) => call.data.completionStatus === "CANCELLED",
      );
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0][0].where.completionStatus).toEqual({
      in: ["SCHEDULED", "RESCHEDULED"],
    });
  });
});

describe("#1161 — a credit-funded booking refunds as a credit restoration", () => {
  /** Fully covered by referral credits: zero captured, synthetic intent. */
  const freeFunded = {
    paymentAmount: 0,
    paymentIntent: "free_1730000000000_ab12cd34",
  };

  it("restores in full and reports what came back, not a hardcoded zero", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], ...freeFunded }),
    );
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r-internal",
      amountRefundedPaise: 25_000,
      rail: "INTERNAL",
    });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // The restoration rail is reached at all — the amount floor on the payment
    // lookup used to make this branch dead code.
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    expect(body.refund.status).toBe("REFUNDED");
    expect(body.refund.amountRefundedPaise).toBe(25_000);
  });

  it("restores a credit-funded booking in full inside a partial window (#1500)", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    // Inside the day: the 50% rung. A credit cannot be halved — the rail refuses a
    // partial amount — so the product rule is to restore it whole. This case used
    // to escalate to MANUAL_REVIEW and move nothing at all.
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [12], ...freeFunded }),
    );
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r-credits",
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // No amountPaise: the credits rail restores the whole credit or nothing.
    const call = mockRefundBookingPayment.mock.calls[0][0];
    expect(call.paymentId).toBe("pay-1");
    expect(call.amountPaise).toBeUndefined();
    expect(body.refund.status).toBe("REFUNDED");
    expect(body.refund.refundPct).toBe(100);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("an expert's cancel of a credit-funded booking announces a required refund", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultant"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], ...freeFunded }),
    );
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r-credits",
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });

    await cancelHandler(makeRequest(), makeParams(APPT));

    const { reason } = mockRefundBookingPayment.mock.calls[0][0];
    expect(refundNoticeKind(reason)).toBe("REFUND_FROM_HOST_CANCEL");
  });

  it("restores nothing inside the zero tier, exactly as a card would (#1500)", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    // One hour out: the 0% rung. All-or-nothing follows the ladder, so a late
    // cancel bites a credit buyer as it bites a card buyer.
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1], ...freeFunded }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(body.refund.status).toBe("POLICY_ZERO");
    expect(body.refund.refundPct).toBe(0);
  });

  it("surfaces a failed restoration rather than reporting it as refunded", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], ...freeFunded }),
    );
    mockRefundBookingPayment.mockRejectedValue(
      new Error("no refundable balance"),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Still owed and queued for the retry sweep, so never reported as refunded.
    expect(body.refund.status).toBe("PENDING");
    expect(body.refund.amountRefundedPaise).toBe(0);
  });
});

describe("#1166 — an admin of the funding org acts on the payer side", () => {
  function orgFundedAppointment() {
    return { ...consultationAppointment(), organizationId: "org-1" };
  }

  it("lets an OWNER of the funding org cancel, and tiers them as the buyer", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-owner-1",
        name: "Org Owner",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });
    // The org's money paid, which is the whole basis of the act-for-org right.
    mockOrgFundingPayment.mockResolvedValue({ paymentMethod: "WALLET" });
    // Inside the final two hours: the buyer's own tier pays nothing here, while
    // the consultant tier would pay in full. The org admin must score as the
    // buyer they act for.
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.refund.refundPct).toBe(0);
    expect(body.refund.amountRefundedPaise).toBe(0);
    expect(txStub.orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        category: "MEMBER",
        action: "APPOINTMENT_CANCELLED_FOR_ORG",
      }),
    });
  });

  it("refuses an EXPERT of the same org", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-expert-1",
        name: "Org Expert",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "EXPERT",
    });
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(403);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("refuses an OWNER when the member's own card paid, however the booking is tagged", async () => {
    // #1854 / ADR 19 — `Appointment.organizationId` is a TAG: checkout stamps it
    // for a `fundingSource: PERSONAL` booking too, so the tag alone used to let
    // an owner cancel (and refund) a member's personal-card consultation.
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-owner-3",
        name: "Org Owner",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });
    mockOrgFundingPayment.mockResolvedValue({ paymentMethod: "CARD" });
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(403);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(txStub.orgAuditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an invited-but-inactive admin", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-owner-2",
        name: "Pending Owner",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "INVITED",
      role: "OWNER",
    });
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(403);
  });
});

describe("failure modes leave the cancellation standing", () => {
  it("reports a failed refund rather than swallowing it", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway down"));

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The owed marker keeps the refund queued for the retry sweep, so the
    // route says it is pending rather than inferring failure from a zero.
    expect(body.refund).toEqual({
      amountRefundedPaise: 0,
      refundPct: 100,
      status: "PENDING",
    });
    // A failed refund on an already-cancelled booking is money owed, so it
    // lands on the durable ops surface, not only in Sentry.
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT" }),
    );
  });

  it("answers PENDING when the gateway threw but the Refund row stays PENDING (#1775 P-3)", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    mockRefundBookingPayment.mockRejectedValue(
      new RefundGatewayError("timeout", "GATEWAY_REFUND_FAILED", "rf_1"),
    );

    const body = await (
      await cancelHandler(makeRequest(), makeParams(APPT))
    ).json();

    expect(body.refund.status).toBe("PENDING");
  });

  it("distinguishes an exhausted balance from a failure", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        liveSlotHours: [120],
        paymentRefunds: [{ amountPaise: GROSS, status: "SUCCEEDED" }],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // Nothing failed and nobody was paged; the money was already returned.
    expect(body.refund.status).toBe("NOTHING_REFUNDABLE");
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("mints no refund for a free booking", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], noPayment: true }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("quotes from a read taken inside the lock, on the transaction client (#1695)", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(200);
    // The tx client served the read; the global client never did, so a
    // reschedule or capture landing before the lock is seen by the quote.
    expect(txStub.appointment.findFirst).toHaveBeenCalledTimes(1);
    expect(globalAppointmentFindFirst).not.toHaveBeenCalled();
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: GROSS }),
    );
  });

  it("does not refund when the cancel loses its CAS race", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(409);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});

describe("the refund is bound to the click", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
  });

  it("refuses a stale quote with 409 and the new figure, committing nothing", async () => {
    const res = await cancelHandler(
      makeRequest({ expectedRefundPaise: GROSS / 2 }),
      makeParams(APPT),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REFUND_QUOTE_CHANGED",
      refundPaise: GROSS,
      refundPct: 100,
    });
    expect(txStub.consultation.updateMany).not.toHaveBeenCalled();
    expect(txStub.payment.updateMany).not.toHaveBeenCalled();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("stamps the confirmed quote owed in the cancel commit, under the cancel's key", async () => {
    const res = await cancelHandler(
      makeRequest({ expectedRefundPaise: GROSS }),
      makeParams(APPT),
    );

    expect(res.status).toBe(200);
    expect(txStub.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundOwedKey: `cancel:${APPT}:pay-1`,
          refundOwedPaise: GROSS,
        }),
      }),
    );
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `cancel:${APPT}:pay-1` }),
    );
  });

  it("answers a retried click with what the first one committed", async () => {
    txStub.consultation.updateMany.mockResolvedValue({ count: 0 });
    mockConsultationFindUnique.mockResolvedValue({
      status: "CANCELLED",
      cancelledBy: CONSULTEE_USER,
      cancelledAt: new Date(),
      cancellationReason: null,
    });
    mockPaymentFindMany.mockResolvedValue([
      {
        id: "pay-1",
        refundOwedKey: null,
        refunds: [
          {
            dedupeKey: `cancel:${APPT}:pay-1`,
            status: "SUCCEEDED",
            amountPaise: GROSS,
          },
        ],
      },
    ]);

    // The retry carries the first click's figure; the requote no longer matches.
    const res = await cancelHandler(
      makeRequest({ expectedRefundPaise: GROSS / 2 }),
      makeParams(APPT),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      replayed: true,
      refund: { status: "REFUNDED", amountRefundedPaise: GROSS },
    });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});

/**
 * #1322 A12 — the route wrote its four request statuses, its slots and its
 * open proposal with raw updateMany calls, so a successful cancel left no
 * BookingStatusHistory row at all and the cancelled slots kept
 * `deletedAt: null`, holding the consultant's calendar forever. The pin is on
 * the audit trail rather than on the call shape, because that is what was
 * empty in production.
 */
describe("a cancel leaves an audit trail", () => {
  it("records the request move and every slot it moved, tombstone included", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.findUnique.mockResolvedValue({ status: "APPROVED" });

    const res = await cancelHandler(
      makeRequest({ reason: "SCHEDULE_CONFLICT" }),
      makeParams(APPT),
    );
    expect(res.status).toBe(200);

    const historyRows = (
      txStub.bookingStatusHistory.create.mock.calls as [
        { data: Record<string, unknown> },
      ][]
    ).map(([args]) => args.data);

    expect(historyRows).toContainEqual(
      expect.objectContaining({
        entity: "CONSULTATION",
        entityId: "cons-1",
        fromStatus: "APPROVED",
        toStatus: "CANCELLED",
        actorUserId: CONSULTEE_USER,
        reason: "SCHEDULE_CONFLICT",
        appointmentId: APPT,
      }),
    );
    // One per slot the CAS actually moved — the ids come from the UPDATE's own
    // RETURNING, so a slot a racing writer pulled out never gets a row.
    expect(
      historyRows.filter((row) => row.entity === "OCCURRENCE"),
    ).toHaveLength(2);
    expect(
      txStub.appointmentOccurrence.updateManyAndReturn,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { completionStatus: "CANCELLED", deletedAt: expect.any(Date) },
      }),
    );
  });

  it("keeps the 409 contract when the request has already moved", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // The helper throws ILLEGAL_TRANSITION; the client still sees the code it
    // has always keyed its retry copy off.
    expect(res.status).toBe(409);
    expect(body.code).toBe("NOT_CANCELLABLE");
    expect(txStub.bookingStatusHistory.create).not.toHaveBeenCalled();
  });
});
