/**
 * @jest-environment node
 */

/**
 * The consultant no-show detector proposes and moves no money: it parks each
 * judged session UNVERIFIED with its verdict. The claim that runs once the
 * HOST_ABSENT verdict is confirmed refunds through the booking front door,
 * never the raw gateway path, and does not skip a credit-funded booking.
 */

import "../booking-algorithm/setup";

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

// The raw gateway-only refund must never be reached from this job again.
const refundPayment = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: (...a: unknown[]) => refundPayment(...(a as [never])),
  findDedupedRefund: async () => null,
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));

// `clearMocks: true` wipes implementations before every test, so the
// resolved value is re-armed in beforeEach — the job does
// `recordSystemError(...).catch(...)` and needs a real promise back.
const recordSystemError = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => {
  return {
    __esModule: true,
    recordSystemError: (...a: unknown[]) =>
      recordSystemError(...(a as [never])),
    recordSystemErrorSafe: (...a: unknown[]) =>
      recordSystemError(...(a as [never])),
  };
});

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyAppointmentCancelled: jest.fn(async () => undefined),
  notifyRefundProcessed: jest.fn(async () => undefined),
}));

// #1493 — claimConsultantNoShow now runs the cancel through
// transitionConsultationRequest inside prisma.$transaction, so the mock needs
// $transaction (running its callback against this same client),
// consultation.findUnique (the helper's pre-read of the from-status), and
// bookingStatusHistory.create (the audit row the helper appends).
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        status: "APPROVED",
        appointment: { id: "appt-1" },
      }),
    },
    // #1583 A-P0-05 — the occurrence release goes through
    // transitionOccurrenceCompletion: a pre-read plus updateManyAndReturn.
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest
        .fn()
        .mockResolvedValue([{ id: "occ-1", appointmentId: "appt-1" }]),
    },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
    },
    maintenanceWindow: { findMany: jest.fn().mockResolvedValue([]) },
    platformIncident: { findMany: jest.fn().mockResolvedValue([]) },
    // The claim writes the expert's reliability strike.
    systemEvent: { create: jest.fn().mockResolvedValue({}) },
    // The claim stamps the owed refund; the drive clears it by CAS.
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // The owed-refund stamp cancels the unsent payouts that batched the payment's earnings; none here.
    consultantEarnings: { findMany: async () => [] },
    organizationEarnings: { findMany: async () => [] },
    refund: { findUnique: async () => null },
    $disconnect: jest.fn(),
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

// The detector moves money only on Stream's settled record; the fixture's
// meeting carries what that record holds.
const mockSettle = jest.fn(
  async (target: {
    occurrenceId: string;
    meeting: { stays: { userId: string; joinedAt: Date; leftAt: Date }[] };
  }) => ({ kind: "settled" as const, intervals: target.meeting.stays }),
);
jest.mock("../../lib/meetings/settle-attendance", () => ({
  settleOccurrenceAttendance: (...a: unknown[]) =>
    mockSettle(...(a as [never])),
}));

const mockSendCancelledEmail = jest.fn(async (..._args: unknown[]) => ({
  sent: 1,
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  EMAIL_BUDGET_MS: { JOB: 1_000 },
  refundOnItsWay: (paise: number, currency: string) =>
    `${currency} ${paise} on its way`,
  sendAppointmentCancelledEmail: (...a: unknown[]) =>
    mockSendCancelledEmail(...(a as [never])),
  sendRefundProcessedEmail: jest.fn(async () => ({ sent: 1 })),
}));

jest.mock("../../lib/support/create-ticket", () => ({
  createSupportTicket: jest.fn(async () => ({ id: "ticket-1" })),
}));

// The proposed-verdict notices: rendered before the proposal's transaction, staged inside it.
const mockPrepareNotices = jest.fn(
  async (session: { occurrenceId: string }) => ({
    entityRef: `appointment:${session.occurrenceId}`,
    bells: [],
    emails: null,
  }),
);
const mockStageNotices = jest.fn(async (..._a: unknown[]) => ({
  bells: [{ id: "bell-1" }],
  emails: [{ id: "email-1" }],
}));
jest.mock("../../lib/booking/outcome-notices", () => ({
  prepareProposedOutcomeNotices: (session: { occurrenceId: string }) =>
    mockPrepareNotices(session),
  stageOutcomeNotices: (...a: unknown[]) => mockStageNotices(...a),
}));
const mockFlushNotices = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...a: unknown[]) => mockFlushNotices(...a),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";
import {
  confirmConsultantNoShow,
  noShowRefundOwed,
  oweSessionNoShowRefundTx,
  readNoShowClaim,
  readOperatorNoShowClaim,
  readSessionNoShow,
  settleSessionNoShowRefund,
} from "../../lib/booking/consultant-no-show";
import { createRunFailureReporter } from "../../lib/observability/run-failures";
import { SWEEP_START_DEADLINE_MS } from "../../lib/cron/run-deadline";
import {
  CONSULTANT_USER,
  CONSULTEE_USER,
  noShowOccurrence,
  rebookedOccurrences,
} from "../fixtures/no-show-occurrence";

/**
 * A candidate the job will classify as a real no-show: the consultee
 * attended, the consultant did not.
 */
function noShowCandidate(payment: {
  id: string;
  amount: number;
  paymentStatus?: string;
}) {
  return {
    id: "cons-1",
    consultationPlan: {
      title: "Career strategy",
      consultantProfileId: "cp-1",
      consultantProfile: {
        userId: CONSULTANT_USER,
        user: { name: "Consultant" },
      },
    },
    requestedBy: { userId: CONSULTEE_USER, user: { name: "Consultee" } },
    appointment: {
      id: "apt-1",
      payment: [
        {
          currency: "INR",
          paymentStatus: "SUCCEEDED",
          ...payment,
        },
      ],
      occurrences: [noShowOccurrence()],
    },
  };
}

type NoShowRun = Awaited<ReturnType<typeof detectConsultantNoShows>>;

function mockIncident(startsAt: string, endsAt: string) {
  (prisma.platformIncident.findMany as jest.Mock).mockResolvedValueOnce([
    { startsAt: new Date(startsAt), endsAt: new Date(endsAt) },
  ]);
}

function expectNoShowSkipped(result: NoShowRun) {
  expect(result.detected).toBe(0);
  expect(
    prisma.appointmentOccurrence.updateManyAndReturn,
  ).not.toHaveBeenCalled();
  expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
  expect(prisma.systemEvent.create).not.toHaveBeenCalled();
  expect(refundBookingPayment).not.toHaveBeenCalled();
}

/** The proposal's write for one session: SCHEDULED -> UNVERIFIED with its verdict, unconfirmed. */
const proposalWrites = () =>
  (
    prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
  ).mock.calls.map(([args]) => args);

/** The claim read's row for a proposed no-show on `occ-1`, in CLAIM_SELECT's shape. */
function proposedClaimRow(payment: { id: string }) {
  return {
    id: "cons-1",
    status: "APPROVED",
    consultationPlan: {
      title: "Career strategy",
      consultantProfileId: "cp-1",
      consultantProfile: {
        userId: CONSULTANT_USER,
        user: { name: "Consultant" },
      },
    },
    requestedBy: { userId: CONSULTEE_USER, user: { name: "Consultee" } },
    appointment: {
      id: "apt-1",
      organizationId: null,
      payment: [{ id: payment.id, currency: "INR" }],
      occurrences: [
        {
          id: "occ-1",
          startsAt: new Date("2026-09-01T10:00:00Z"),
          endsAt: new Date("2026-09-01T11:00:00Z"),
          deletedAt: null,
          isTentative: false,
          completionStatus: "UNVERIFIED",
          outcome: "HOST_ABSENT",
          outcomeConfirmedAt: null,
          seatsSettledAt: null,
          meeting: { presences: [{ userId: CONSULTEE_USER }] },
        },
      ],
    },
  };
}

const confirmOcc1 = (
  errors: string[] = [],
  siblingGuard: (id: string) => { id: string } | null = () => null,
) =>
  confirmConsultantNoShow("occ-1", {
    now: new Date("2026-09-04T12:00:00Z"),
    guard: { id: "the-pass-guard" },
    siblingGuard,
    errors,
    failures: createRunFailureReporter("bookings"),
  });

/** The claim read's row with a second standing expert-absent proposal, `occ-2`. */
function twoProposedSessions() {
  const row = proposedClaimRow({ id: "pay-1" });
  row.appointment.occurrences.push({
    ...row.appointment.occurrences[0],
    id: "occ-2",
  });
  return row;
}

describe("consultant no-show refunds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    recordSystemError.mockResolvedValue(undefined);
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 150000,
      rail: "GATEWAY",
    });
  });

  it("drains a backlog of 30 candidates in one run, bite after bite", async () => {
    const backlog = Array.from({ length: 30 }, (_, i) => ({
      ...noShowCandidate({ id: `pay-${i}`, amount: 150000 }),
      id: `cons-${i}`,
    }));
    (prisma.consultation.findMany as jest.Mock).mockImplementation(
      async (args: { take: number; where: { id?: { notIn: string[] } } }) =>
        backlog
          .filter((c) => !args.where.id?.notIn.includes(c.id))
          .slice(0, args.take),
    );

    const result = await detectConsultantNoShows({ maxCandidates: 10 });

    expect(result.detected).toBe(30);
    expect(proposalWrites()).toHaveLength(30);
  });

  it("bounds each candidate's Stream reads by the run's start budget", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    const startedAt = Date.now();

    await detectConsultantNoShows({ startedAt });

    expect(mockSettle).toHaveBeenCalledWith(expect.anything(), {
      failures: expect.anything(),
      deadlineAt: startedAt + SWEEP_START_DEADLINE_MS,
    });
  });

  it("proposes the no-show and writes no refund, owed marker, cancel or strike", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(1);
    expect(proposalWrites()).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          id: "occ-1",
          completionStatus: { in: ["SCHEDULED"] },
        }),
        data: expect.objectContaining({
          completionStatus: "UNVERIFIED",
          outcome: "HOST_ABSENT",
          outcomeConfirmedAt: null,
        }),
      }),
    ]);
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.systemEvent.create).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("tells both sides of the proposal with the write that makes it: prepared before, staged in its transaction, sent after", async () => {
    const candidate = noShowCandidate({ id: "pay-1", amount: 150000 });
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([candidate]);

    await detectConsultantNoShows();

    const [session] = candidate.appointment.occurrences;
    expect(mockPrepareNotices).toHaveBeenCalledTimes(1);
    expect(mockPrepareNotices).toHaveBeenCalledWith({
      occurrenceId: "occ-1",
      appointmentId: "apt-1",
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      outcome: "HOST_ABSENT",
      outcomeAt: expect.any(Date),
    });
    // The notice names the verdict's own time, which the window is counted from.
    const [write] = proposalWrites();
    expect(mockPrepareNotices.mock.calls[0][0]).toMatchObject({
      outcomeAt: write.data.outcomeAt,
    });
    expect(mockStageNotices).toHaveBeenCalledTimes(1);
    expect(mockStageNotices.mock.calls[0][0]).toBe(prisma);
    expect(mockFlushNotices).toHaveBeenCalledWith(
      {
        bells: [{ id: "bell-1" }],
        emails: [
          {
            rows: [{ id: "email-1" }],
            emailType: "SESSION_OUTCOME_PROPOSED",
          },
        ],
      },
      "detect-consultant-no-shows",
    );
  });

  it("proposes nothing when the notices cannot be prepared, so no report window starts unannounced; the next run proposes with them", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    mockPrepareNotices.mockRejectedValueOnce(new Error("renderer down"));

    const first = await detectConsultantNoShows();

    expect(first.detected).toBe(0);
    expect(proposalWrites()).toEqual([]);
    expect(mockStageNotices).not.toHaveBeenCalled();

    const next = await detectConsultantNoShows();

    expect(next.detected).toBe(1);
    expect(proposalWrites()).toHaveLength(1);
    expect(mockStageNotices).toHaveBeenCalledTimes(1);
  });

  it("stages no notice for a proposal another writer beat to the session", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mockResolvedValueOnce([]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expect(mockStageNotices).not.toHaveBeenCalled();
    expect(mockFlushNotices).not.toHaveBeenCalled();
  });

  it("the confirmed claim refunds through the front door, never the raw gateway path", async () => {
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(
      proposedClaimRow({ id: "pay-1" }),
    );

    const result = await confirmOcc1();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        initiatedByUserId: null,
        reason: expect.stringContaining("no-show"),
      }),
    );
    // Org-funded intents die inside refundPayment.
    expect(refundPayment).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "claimed", refunded: true, held: null });
    // The strike session's CAS carries the caller's guard, and stamps the confirmation with the cancel.
    const [strikeMove] = (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mock.calls[0];
    expect(strikeMove.where.AND[0]).toEqual({ id: "the-pass-guard" });
    expect(strikeMove.data).toMatchObject({
      completionStatus: "CANCELLED",
      outcomeConfirmedAt: expect.any(Date),
    });
    // The claim's transaction writes the expert's strike.
    expect(prisma.systemEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "expert-reliability:cp-1",
      }),
    });
  });

  it("claims a fully credit-funded booking (amount 0) instead of skipping it", async () => {
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(
      proposedClaimRow({ id: "pay-free" }),
    );
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });

    const result = await confirmOcc1();

    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-free" }),
    );
    expect(result).toMatchObject({ kind: "claimed", refunded: true });
    // And the booking itself was cancelled, not left live.
    expect(prisma.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  // The cohort reads live slots; the proposal's CAS judges only undecided SCHEDULED ones.
  it("scopes the cohort to live slots and the proposal's CAS to undecided SCHEDULED occurrences", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    await detectConsultantNoShows();

    const slot = {
      deletedAt: null,
      completionStatus: { in: ["SCHEDULED", "RESCHEDULED"] },
      endsAt: { lt: expect.any(Date) },
      meeting: { isNot: null },
    };
    const decidedOrParked = {
      deletedAt: null,
      OR: [
        { outcome: { not: null } },
        { completionStatus: "UNVERIFIED" },
        { completionStatus: "COMPLETED" },
      ],
      NOT: {
        completionStatus: "VOIDED",
        outcome: "PLATFORM_OUTAGE",
        seatsSettledAt: { not: null },
      },
    };
    const [query] = (prisma.consultation.findMany as jest.Mock).mock.calls[0];
    expect(query.where.appointment.occurrences.some).toMatchObject(slot);
    expect(query.where.appointment.occurrences.none).toEqual(decidedOrParked);
    expect(query.include.appointment.include.occurrences.orderBy).toEqual({
      startsAt: "asc",
    });
    const [release] = proposalWrites();
    expect(release.where).toMatchObject({
      id: "occ-1",
      deletedAt: null,
      outcome: null,
      isTentative: false,
      completionStatus: { in: ["SCHEDULED"] },
    });
  });

  it.each([
    ["deleted", { deletedAt: new Date("2026-09-01T09:00:00Z") }],
    ["rescheduled", { completionStatus: "RESCHEDULED" }],
    ["decided", { outcome: "HELD" }],
    ["tentative", { isTentative: true }],
    ["not ended", { endsAt: new Date("2099-01-01T00:00:00Z") }],
  ])("does not judge an occurrence that is %s", async (_label, patch) => {
    const candidate = noShowCandidate({ id: "pay-1", amount: 150000 });
    Object.assign(candidate.appointment.occurrences[0], patch);
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([candidate]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
  });

  it("judges the live rebooked occurrence after an incident voided the original", async () => {
    const candidate = noShowCandidate({ id: "pay-1", amount: 150000 });
    candidate.appointment.occurrences = rebookedOccurrences();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([candidate]);
    (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mockResolvedValue([{ id: "occ-new", appointmentId: "apt-1" }]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(1);
    // Only the live rebooked session is judged, so only its record is settled and proposed.
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle.mock.calls[0][0].occurrenceId).toBe("occ-new");
    expect(proposalWrites().map((w) => w.where.id)).toEqual(["occ-new"]);
  });

  it("does not judge a rebooked occurrence that itself overlaps a declared incident", async () => {
    const candidate = noShowCandidate({ id: "pay-1", amount: 150000 });
    candidate.appointment.occurrences = rebookedOccurrences();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([candidate]);
    mockIncident("2026-09-08T10:30:00Z", "2026-09-08T12:00:00Z");

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expectNoShowSkipped(result);
  });

  it.each([
    ["HELD", { completionStatus: "COMPLETED", outcome: "HELD" }],
    ["UNVERIFIED", { completionStatus: "UNVERIFIED", outcome: "INCONCLUSIVE" }],
  ])(
    "does not propose when a decided %s sibling exists",
    async (_label, sibling) => {
      const candidate = noShowCandidate({ id: "pay-1", amount: 150000 });
      candidate.appointment.occurrences = [
        noShowOccurrence({ id: "occ-sibling", ...sibling }),
        noShowOccurrence(),
      ];
      (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
        candidate,
      ]);

      const result = await detectConsultantNoShows();

      expect(result.detected).toBe(0);
      expectNoShowSkipped(result);
    },
  );

  it("does not propose when a sibling session was joined by nobody: only a booking whose every session is expert-absent is automatic", async () => {
    const candidate = noShowCandidate({ id: "pay-1", amount: 150000 });
    candidate.appointment.occurrences = [
      noShowOccurrence(),
      noShowOccurrence({
        id: "occ-empty",
        startsAt: new Date("2026-09-02T10:00:00Z"),
        endsAt: new Date("2026-09-02T11:00:00Z"),
        meeting: {
          id: "meeting-2",
          endedAt: new Date("2026-09-02T11:00:00Z"),
          stays: [],
        },
      }),
    ];
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([candidate]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expectNoShowSkipped(result);
  });

  it.each(["NOBODY_JOINED", "OFFLINE"])(
    "declines a proposal whose sibling is parked %s, writing nothing",
    async (outcome) => {
      const row = proposedClaimRow({ id: "pay-1" });
      row.appointment.occurrences.push({
        ...row.appointment.occurrences[0],
        id: "occ-empty",
        outcome,
        meeting: { presences: [] },
      });
      (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(row);

      expect(await confirmOcc1()).toEqual({ kind: "declined" });
      expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
      expect(prisma.systemEvent.create).not.toHaveBeenCalled();
      expect(refundBookingPayment).not.toHaveBeenCalled();
    },
  );

  it("declines a proposal whose other proposed session the pass has not judged strong and undisputed, writing nothing", async () => {
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(
      twoProposedSessions(),
    );

    expect(await confirmOcc1([], () => null)).toEqual({ kind: "declined" });
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
    expect(prisma.systemEvent.create).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("hands each other proposed session's own guard to that session's compare-and-set", async () => {
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(
      twoProposedSessions(),
    );

    const result = await confirmOcc1([], (id) => ({ id: `guard-of-${id}` }));

    expect(result).toMatchObject({ kind: "claimed" });
    const [, [siblingMove]] = (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mock.calls;
    expect(siblingMove.where).toMatchObject({
      id: { in: ["occ-2"] },
      OR: [{ id: "guard-of-occ-2" }],
    });
  });

  it("is lost when another proposed session's compare-and-set moves no row: no owed refund, strike or refund follows", async () => {
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(
      twoProposedSessions(),
    );
    // The strike session moves; the other session's guard no longer matches.
    (prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock)
      .mockResolvedValueOnce([{ id: "occ-1", appointmentId: "appt-1" }])
      .mockResolvedValueOnce([]);

    const result = await confirmOcc1([], (id) => ({ id: `guard-of-${id}` }));

    expect(result).toEqual({ kind: "lost" });
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.systemEvent.create).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("does not filter the candidate query on a positive amount", async () => {
    await detectConsultantNoShows();

    const [args] = (prisma.consultation.findMany as jest.Mock).mock.calls[0];
    const paymentFilter = args.where.appointment.payment.some;
    expect(paymentFilter).toEqual({
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    });
    expect(paymentFilter).not.toHaveProperty("amount");
  });

  it("records a durable system event when the confirmed claim's refund fails", async () => {
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(
      proposedClaimRow({ id: "pay-boom" }),
    );
    refundBookingPayment.mockRejectedValue(new Error("gateway refused"));
    const errors: string[] = [];

    const result = await confirmOcc1(errors);

    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        summary: expect.stringContaining("cons-1"),
        context: expect.objectContaining({ paymentId: "pay-boom" }),
      }),
    );
    expect(result).toMatchObject({ kind: "claimed", refunded: false });
    expect(errors).toHaveLength(1);
  });

  it("declines a proposal whose booking holds a completed session with no outcome, writing nothing", async () => {
    const row = proposedClaimRow({ id: "pay-1" });
    row.appointment.occurrences.push({
      ...row.appointment.occurrences[0],
      id: "occ-held",
      completionStatus: "COMPLETED",
      outcome: null as unknown as string,
    });
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(row);

    expect(await confirmOcc1()).toEqual({ kind: "declined" });
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("declines a proposal whose booking holds a decided sibling, writing nothing", async () => {
    const row = proposedClaimRow({ id: "pay-1" });
    row.appointment.occurrences.push({
      ...row.appointment.occurrences[0],
      id: "occ-held",
      completionStatus: "COMPLETED",
      outcome: "HELD",
    });
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(row);

    expect(await confirmOcc1()).toEqual({ kind: "declined" });
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
    expect(prisma.systemEvent.create).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  describe("an operator's own expert-absent verdict", () => {
    const judge = (row: ReturnType<typeof proposedClaimRow>) => {
      (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(row);
      return readOperatorNoShowClaim(prisma, "occ-1");
    };

    it("takes the claim on a session not yet parked as a proposal and whatever the stored presence, which the detector's rule declines", async () => {
      const row = proposedClaimRow({ id: "pay-1" });
      Object.assign(row.appointment.occurrences[0], {
        outcome: "INCONCLUSIVE",
        meeting: { presences: [{ userId: CONSULTANT_USER }] },
      });

      expect(await judge(row)).toMatchObject({
        claim: { strikeOccurrenceId: "occ-1", occurrenceIds: ["occ-1"] },
      });
      expect(await readNoShowClaim(prisma, "occ-1")).toBeNull();
    });

    it("names why a booking cannot take it, with what the door needs to choose the session-level remedy", async () => {
      const unpaid = proposedClaimRow({ id: "pay-1" });
      unpaid.appointment.payment = [];
      expect(await judge(unpaid)).toEqual({ bar: { reason: "UNPAID" } });

      const completed = proposedClaimRow({ id: "pay-1" });
      completed.status = "COMPLETED";
      expect(await judge(completed)).toEqual({
        bar: {
          reason: "NOT_APPROVED",
          status: "COMPLETED",
          paid: true,
          otherSessions: 0,
        },
      });

      const held = proposedClaimRow({ id: "pay-1" });
      held.appointment.occurrences.push({
        ...held.appointment.occurrences[0],
        id: "occ-held",
        completionStatus: "COMPLETED",
        outcome: "HELD",
      });
      expect(await judge(held)).toMatchObject({
        bar: {
          reason: "SIBLING",
          siblings: [{ id: "occ-held", outcome: "HELD" }],
        },
      });
      // The same booking once it is no longer approved: the held session is one that stands.
      held.status = "COMPLETED";
      expect(await judge(held)).toMatchObject({
        bar: { reason: "NOT_APPROVED", paid: true, otherSessions: 1 },
      });
    });
  });

  describe("a booking refunded in full for one session's expert absence, without being cancelled", () => {
    const completed = () => {
      const row = proposedClaimRow({ id: "pay-1" });
      row.status = "COMPLETED";
      Object.assign(row.appointment.occurrences[0], {
        completionStatus: "COMPLETED",
        outcome: "HELD",
      });
      (prisma.consultation.findFirst as jest.Mock).mockResolvedValue(row);
      return row;
    };

    it("owes the full balance under a key of its own, drives it through the front door and tells the learner, cancelling nothing", async () => {
      completed();
      const session = await readSessionNoShow(prisma, "occ-1");
      expect(session).toMatchObject({
        status: "COMPLETED",
        otherSessions: 0,
        refund: { occurrenceId: "occ-1", payment: { id: "pay-1" } },
      });

      const { held } = await oweSessionNoShowRefundTx(
        prisma as never,
        session!.refund!,
      );

      const key = "expert-absent:occ-1:pay:pay-1";
      // Neither the whole-booking claim's key nor the day-14 sweep's per-session key.
      expect(key).not.toBe(noShowRefundOwed("pay-1").key);
      expect(key.startsWith("occ:")).toBe(false);
      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refundOwedKey: key,
            refundOwedPaise: null,
          }),
        }),
      );
      expect(prisma.consultation.updateMany).not.toHaveBeenCalled();

      const settled = await settleSessionNoShowRefund(session!.refund!, held, {
        errors: [],
        failures: createRunFailureReporter("admin"),
      });
      expect(settled).toEqual({ refunded: true });
      expect(refundBookingPayment).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "pay-1", dedupeKey: key }),
      );
    });

    it("counts the booking's other standing sessions and answers no refund party for an unpaid booking", async () => {
      const row = completed();
      row.appointment.payment = [];
      row.appointment.occurrences.push({
        ...row.appointment.occurrences[0],
        id: "occ-2",
      });
      expect(await readSessionNoShow(prisma, "occ-1")).toMatchObject({
        otherSessions: 1,
        refund: null,
      });
    });
  });

  it("neither claims nor strikes a session inside a declared incident", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    mockIncident("2026-09-01T10:30:00Z", "2026-09-01T12:00:00Z");

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expectNoShowSkipped(result);
  });

  it("leaves a session the consultant actually attended alone", async () => {
    const attended = noShowCandidate({ id: "pay-1", amount: 150000 });
    attended.appointment.occurrences[0].meeting.stays.push({
      userId: CONSULTANT_USER,
      joinedAt: new Date("2026-09-01T10:00:00Z"),
      leftAt: new Date("2026-09-01T11:00:00Z"),
    });
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([attended]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expectNoShowSkipped(result);
  });

  it("is not a no-show when the consultant joined only after the booked end, during the rejoin grace", async () => {
    // The learner waited the whole hour; the consultant arrived at 11:05, inside the rejoin grace.
    const late = noShowCandidate({ id: "pay-1", amount: 150000 });
    late.appointment.occurrences[0].meeting.stays.push({
      userId: CONSULTANT_USER,
      joinedAt: new Date("2026-09-01T11:05:00Z"),
      leftAt: new Date("2026-09-01T11:20:00Z"),
    });
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([late]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expectNoShowSkipped(result);
  });
});
