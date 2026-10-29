/**
 * @jest-environment node
 */

/**
 * E2E-audit P1 — consultant no-show refunds must go through the booking
 * front door, and must not skip credit-funded bookings.
 *
 * Two defects, one job (`detect-consultant-no-shows`, hourly):
 *
 * 1. It refunded via raw `refundPayment`, which only understands gateway
 *    intents. An ORG-FUNDED booking carries an internal intent id
 *    (org_wallet_ / org_invoice_ / org_license_), so the call threw
 *    UNKNOWN_GATEWAY *after* the booking had already been claimed as
 *    CANCELLED — stranding a PENDING refund placeholder until the reconcile
 *    cron failed it a day later. `refundBookingPayment` is the front door
 *    that splits the gateway / in-ledger-org / credits rails (doctrine
 *    rule 3).
 *
 * 2. Both the candidate query and the payment picker required `amount > 0`,
 *    so a session paid entirely out of referral credits was invisible to the
 *    job: the consultant no-showed, and the consultee got neither a
 *    cancellation nor their credits back.
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
    payment: { updateMany: async () => ({ count: 1 }) },
    refund: { findUnique: async () => null },
    $disconnect: jest.fn(),
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

// #1280 — the detector now corroborates against Stream before refunding,
// because our attendance rows come from per-participant webhook deliveries that
// can be lost independently. These cases model a no-show Stream AGREES with:
// exactly one participant was in the call. Without this the suite exercises the
// refusal path instead, and no refund fires at all.
const mockEvidence = jest.fn(async (_callId?: string) => ({
  unique: 1,
  maxConcurrent: 1,
}));
jest.mock("../../lib/stream/call-presence", () => ({
  getCallPresenceEvidence: (...a: unknown[]) => mockEvidence(...(a as [never])),
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

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";

const CONSULTANT_USER = "user-consultant";
const CONSULTEE_USER = "user-consultee";

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
      occurrences: [
        {
          id: "occ-1",
          startsAt: new Date("2026-09-01T10:00:00Z"),
          endsAt: new Date("2026-09-01T11:00:00Z"),
          completionStatus: "SCHEDULED",
          outcome: null,
          deletedAt: null,
          isTentative: false,
          // #1569 — the shared classifier reads per-device presence intervals.
          presences: [
            {
              userId: CONSULTEE_USER,
              joinedAt: new Date("2026-09-01T10:00:00Z"),
              leftAt: new Date("2026-09-01T11:00:00Z"),
            },
          ],
          meeting: {
            endedAt: new Date("2026-09-01T11:00:00Z"),
            endedReason: "call_ended",
            // #1280 — the detector now asks Stream to corroborate before any
            // money moves, so the session needs a call id for it to ask about.
            // Without one it refuses, which is the correct behaviour and not
            // what these cases are exercising.
            streamCallId: "slot-cons-1",
            // Only the consultee shows up.
            attendances: [{ userId: CONSULTEE_USER }],
          },
        },
      ],
    },
  };
}

describe("consultant no-show refunds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    mockEvidence.mockImplementation(async () => ({
      unique: 1,
      maxConcurrent: 1,
    }));
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

    expect(result.refunded).toBe(30);
    expect(refundBookingPayment).toHaveBeenCalledTimes(30);
  });

  it("refunds through the front door, never the raw gateway path", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);

    const result = await detectConsultantNoShows();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        initiatedByUserId: null,
        reason: expect.stringContaining("no-show"),
      }),
    );
    // The whole point of the fix: org-funded intents die inside refundPayment.
    expect(refundPayment).not.toHaveBeenCalled();
    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
    // D10 — the claim's transaction writes the expert's strike.
    expect(prisma.systemEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "expert-reliability:cp-1",
      }),
    });
  });

  it("handles a fully credit-funded booking (amount 0) instead of skipping it", async () => {
    // Pre-fix this row was filtered out at BOTH the candidate query and the
    // payment picker, so the booking was never even cancelled.
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-free", amount: 0 }),
    ]);
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });

    const result = await detectConsultantNoShows();

    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-free" }),
    );
    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
    // And the booking itself was cancelled, not left live.
    expect(prisma.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  // A live, undecided SCHEDULED session is the only one this job may judge.
  it("judges only live, undecided SCHEDULED occurrences in the cohort and the claim's CAS", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    await detectConsultantNoShows();

    const slot = {
      deletedAt: null,
      completionStatus: "SCHEDULED",
      outcome: null,
      isTentative: false,
      meeting: { isNot: null },
    };
    const [query] = (prisma.consultation.findMany as jest.Mock).mock.calls[0];
    expect(query.where.appointment.occurrences.some).toMatchObject(slot);
    expect(query.where.appointment.occurrences).not.toHaveProperty("none");
    const [claim] = (prisma.consultation.updateMany as jest.Mock).mock.calls[0];
    expect(claim.where.appointment.occurrences.some).toMatchObject({
      id: { in: ["occ-1"] },
      deletedAt: null,
      completionStatus: "SCHEDULED",
      outcome: null,
      isTentative: false,
    });
    const [release] = (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mock.calls[0];
    expect(release.where).toMatchObject({
      id: { in: ["occ-1"] },
      deletedAt: null,
      outcome: null,
      isTentative: false,
      completionStatus: { in: ["SCHEDULED"] },
    });
  });

  it("judges the live rebooked occurrence after an incident voided the original", async () => {
    const rebooked = noShowCandidate({ id: "pay-1", amount: 150000 });
    const [original] = rebooked.appointment.occurrences;
    const candidate = {
      ...rebooked,
      appointment: {
        ...rebooked.appointment,
        occurrences: [
          {
            ...original,
            id: "occ-old",
            completionStatus: "VOIDED",
            outcome: "PLATFORM_OUTAGE",
            meeting: { ...original.meeting, streamCallId: "slot-old" },
          },
          {
            id: "occ-new",
            startsAt: new Date("2026-09-08T10:00:00Z"),
            endsAt: new Date("2026-09-08T11:00:00Z"),
            completionStatus: "SCHEDULED",
            outcome: null,
            deletedAt: null,
            isTentative: false,
            presences: [
              {
                userId: CONSULTEE_USER,
                joinedAt: new Date("2026-09-08T10:00:00Z"),
                leftAt: new Date("2026-09-08T11:00:00Z"),
              },
            ],
            meeting: {
              endedAt: new Date("2026-09-08T11:00:00Z"),
              endedReason: "call_ended",
              streamCallId: "slot-new",
              attendances: [{ userId: CONSULTEE_USER }],
            },
          },
        ],
      },
    };
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([candidate]);
    mockEvidence.mockImplementation(async (callId?: string) => ({
      unique: callId === "slot-old" ? 2 : 1,
      maxConcurrent: 1,
    }));
    (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mockResolvedValue([{ id: "occ-new", appointmentId: "apt-1" }]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    // The voided original's call had two participants; judging it would refuse.
    expect(mockEvidence).toHaveBeenCalledTimes(1);
    expect(mockEvidence).toHaveBeenCalledWith("slot-new");
    const [claim] = (prisma.consultation.updateMany as jest.Mock).mock.calls[0];
    expect(claim.where.appointment.occurrences.some.id).toEqual({
      in: ["occ-new"],
    });
    const [release] = (
      prisma.appointmentOccurrence.updateManyAndReturn as jest.Mock
    ).mock.calls[0];
    expect(release.where.id).toEqual({ in: ["occ-new"] });
    expect(prisma.systemEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        context: expect.objectContaining({ occurrenceId: "occ-new" }),
      }),
    });
    expect(mockSendCancelledEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        startsAt: new Date("2026-09-08T10:00:00Z"),
      }),
      expect.any(Number),
    );
  });

  it("does not judge a rebooked occurrence that itself overlaps a declared incident", async () => {
    const rebooked = noShowCandidate({ id: "pay-1", amount: 150000 });
    const [original] = rebooked.appointment.occurrences;
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      {
        ...rebooked,
        appointment: {
          ...rebooked.appointment,
          occurrences: [
            {
              ...original,
              id: "occ-old",
              completionStatus: "VOIDED",
              outcome: "PLATFORM_OUTAGE",
              meeting: { ...original.meeting, streamCallId: "slot-old" },
            },
            {
              id: "occ-new",
              startsAt: new Date("2026-09-08T10:00:00Z"),
              endsAt: new Date("2026-09-08T11:00:00Z"),
              completionStatus: "SCHEDULED",
              outcome: null,
              deletedAt: null,
              isTentative: false,
              presences: [
                {
                  userId: CONSULTEE_USER,
                  joinedAt: new Date("2026-09-08T10:00:00Z"),
                  leftAt: new Date("2026-09-08T11:00:00Z"),
                },
              ],
              meeting: {
                endedAt: new Date("2026-09-08T11:00:00Z"),
                endedReason: "call_ended",
                streamCallId: "slot-new",
                attendances: [{ userId: CONSULTEE_USER }],
              },
            },
          ],
        },
      },
    ]);
    (prisma.platformIncident.findMany as jest.Mock).mockResolvedValueOnce([
      {
        startsAt: new Date("2026-09-08T10:30:00Z"),
        endsAt: new Date("2026-09-08T12:00:00Z"),
      },
    ]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
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

  it("records a durable system event when the refund fails", async () => {
    // Pre-fix a refund failure existed only in this job's stdout, so ops had
    // no signal that a cancelled booking still owed money.
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-boom", amount: 150000 }),
    ]);
    refundBookingPayment.mockRejectedValue(new Error("gateway refused"));

    const result = await detectConsultantNoShows();

    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        summary: expect.stringContaining("cons-1"),
        context: expect.objectContaining({ paymentId: "pay-boom" }),
      }),
    );
    expect(result.refunded).toBe(0);
    expect(result.success).toBe(false);
  });

  it("neither claims nor strikes a session inside a declared incident", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);
    (prisma.platformIncident.findMany as jest.Mock).mockResolvedValueOnce([
      {
        startsAt: new Date("2026-09-01T10:30:00Z"),
        endsAt: new Date("2026-09-01T12:00:00Z"),
      },
    ]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
    expect(prisma.systemEvent.create).not.toHaveBeenCalled();
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("leaves a session the consultant actually attended alone", async () => {
    const attended = noShowCandidate({ id: "pay-1", amount: 150000 });
    attended.appointment.occurrences[0].presences.push({
      userId: CONSULTANT_USER,
      joinedAt: new Date("2026-09-01T10:00:00Z"),
      leftAt: new Date("2026-09-01T11:00:00Z"),
    });
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([attended]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
  });
});
