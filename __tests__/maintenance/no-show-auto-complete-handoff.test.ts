/**
 * @jest-environment node
 */

/**
 * #1504 — the consultant no-show refund was structurally unreachable.
 *
 * `auto-complete-appointments` runs at :07 and claims every APPROVED/SCHEDULED
 * consultation whose slots ended more than an hour ago;
 * `detect-consultant-no-shows` runs at :57, reads the same two statuses, and
 * only considers a booking whose slots ended more than two hours ago. The
 * completing job therefore always got there first, the booking was COMPLETED
 * before the detector could look at it, and the promised full refund for a
 * consultant who never joined could not fire in production.
 *
 * These pins hold the partition: an unattended consultation belongs to the
 * detector, an attended one belongs to auto-complete, and no consultation
 * belongs to neither.
 */

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn(async () => undefined);
  return {
    __esModule: true,
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyAppointmentCompleted: jest.fn(async () => undefined),
  notifyAppointmentCancelled: jest.fn(async () => undefined),
  notifyRefundProcessed: jest.fn(async () => undefined),
}));

jest.mock("../../lib/support/create-ticket", () => ({
  __esModule: true,
  createSupportTicket: jest.fn(async () => ({ id: "ticket-1" })),
}));

// The detector moves money only on Stream's settled record; this is what it stored.
const settlement: {
  current: Awaited<
    ReturnType<
      typeof import("../../lib/meetings/settle-attendance").settleOccurrenceAttendance
    >
  >;
} = { current: { kind: "settled", intervals: [] } };
jest.mock("../../lib/meetings/settle-attendance", () => ({
  ...jest.requireActual("../../lib/meetings/settle-attendance"),
  settleOccurrenceAttendance: jest.fn(async () => settlement.current),
}));

const reportStandingFinding = jest.fn(async (..._args: unknown[]) => true);
jest.mock("../../lib/observability/standing-finding", () => ({
  __esModule: true,
  reportStandingFinding: (...a: unknown[]) => reportStandingFinding(...a),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

// #1493 — the no-show detector's claim now runs through
// transitionConsultationRequest inside prisma.$transaction, which needs
// consultation.findUnique (the helper's pre-read) and bookingStatusHistory
// (the audit row it appends) alongside $transaction itself.
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    webinar: { findMany: jest.fn(), updateMany: jest.fn() },
    class: { findMany: jest.fn(), updateMany: jest.fn() },
    subscription: { findMany: jest.fn(), updateMany: jest.fn() },
    trial: { findMany: jest.fn() },
    // #1583 A-P0-05 — the no-show release now runs through
    // transitionOccurrenceCompletion (pre-read + updateManyAndReturn).
    appointmentOccurrence: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      updateManyAndReturn: jest.fn(),
      count: jest.fn(async () => 0),
    },
    supportCase: { findFirst: jest.fn() },
    maintenanceWindow: { findMany: jest.fn(async () => []) },
    platformIncident: { findMany: jest.fn(async () => []) },
    bookingStatusHistory: { create: jest.fn() },
    // The claim writes the expert's reliability strike.
    systemEvent: { create: jest.fn(async () => ({})) },
    // The claim stamps the owed refund; the drive clears it by CAS.
    payment: { updateMany: async () => ({ count: 1 }) },
    refund: { findUnique: async () => null },
    $disconnect: jest.fn(),
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import prisma from "../../lib/prisma";
import { autoCompleteAppointments } from "../../scripts/appointments/auto-complete-appointments";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";
import {
  NO_SHOW_GRACE_MINUTES,
  NO_SHOW_HANDOFF_MINUTES,
  isPastNoShowHandoff,
} from "../../lib/booking/attendance";

const CONSULTANT = "user-consultant";
const CONSULTEE = "user-consultee";
const HOURLY_MINUTES = 60;

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & {
  $disconnect: jest.Mock;
};

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

/**
 * A past, paid consultation; `attendees` is who Stream's settled record shows
 * and `completionStatus` is what the slot pass decided for its session.
 */
function consultation(
  endedMinutesAgo: number,
  attendees: string[],
  completionStatus = "SCHEDULED",
) {
  settlement.current = {
    kind: "settled",
    intervals: attendees.map((userId) => ({
      userId,
      joinedAt: minutesAgo(endedMinutesAgo + 60),
      leftAt: minutesAgo(endedMinutesAgo),
    })),
  };
  return {
    id: "cons-1",
    status: "APPROVED",
    consultationPlan: {
      title: "Career strategy",
      consultantProfile: { userId: CONSULTANT, user: { name: "Consultant" } },
    },
    requestedBy: { userId: CONSULTEE, user: { name: "Consultee" } },
    appointment: {
      id: "apt-1",
      organizationId: null,
      payment: [
        {
          id: "pay-1",
          amount: 150000,
          currency: "INR",
          paymentStatus: "SUCCEEDED",
        },
      ],
      occurrences: [
        {
          id: "occ-1",
          startsAt: minutesAgo(endedMinutesAgo + 60),
          endsAt: minutesAgo(endedMinutesAgo),
          completionStatus,
          outcome: null,
          isTentative: false,
          deletedAt: null,
          meeting: {
            id: "meeting-1",
            streamCallId: "call-1",
            extendedSeconds: 0,
            attendanceSettledAt: null,
            endedAt: minutesAgo(endedMinutesAgo),
            endedReason: "call_ended",
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of [
    "consultation",
    "webinar",
    "class",
    "subscription",
    "trial",
    "appointmentOccurrence",
  ]) {
    db[model].findMany.mockResolvedValue([]);
    db[model].updateMany?.mockResolvedValue({ count: 1 });
  }
  // The release CAS moves the booking's one occurrence; `[]` is reserved for
  // the lost-race case below, where the claim must roll back.
  db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
    { id: "occ-1", appointmentId: "apt-1" },
  ]);
  db.supportCase.findFirst.mockResolvedValue(null);
  db.consultation.findUnique.mockResolvedValue({
    status: "APPROVED",
    appointment: { id: "appt-1" },
  });
  db.bookingStatusHistory.create.mockResolvedValue({});
  refundBookingPayment.mockResolvedValue({
    amountRefundedPaise: 150000,
    rail: "GATEWAY",
  });
});

describe("#1504 the two hourly jobs partition past consultations", () => {
  it("auto-complete leaves an unattended consultation inside the grace window to the detector", async () => {
    db.consultation.findMany.mockResolvedValue([consultation(90, [CONSULTEE])]);

    const result = await autoCompleteAppointments();

    expect(result.consultationsCompleted).toBe(0);
    expect(db.consultation.updateMany).not.toHaveBeenCalled();
  });

  it("the detector then cancels and refunds it once it is past the grace window", async () => {
    db.consultation.findMany.mockResolvedValue([
      consultation(NO_SHOW_GRACE_MINUTES + 30, [CONSULTEE]),
    ]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    expect(db.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("the detector rolls the claim back when no live occurrence is left to take", async () => {
    // A concurrent writer took the sessions first: the occurrence CAS moves
    // zero rows, the parent cancel must not commit, and no refund is issued.
    db.consultation.findMany.mockResolvedValue([
      consultation(NO_SHOW_GRACE_MINUTES + 30, [CONSULTEE]),
    ]);
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([]);

    const result = await detectConsultantNoShows();

    expect(result.refunded).toBe(0);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("auto-complete still completes a consultation the consultant attended", async () => {
    db.consultation.findMany.mockResolvedValue([
      consultation(90, [CONSULTEE, CONSULTANT], "COMPLETED"),
    ]);

    const result = await autoCompleteAppointments();

    expect(result.consultationsCompleted).toBe(1);
    expect(db.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("completes an unattended consultation the detector declined, so none is stranded", async () => {
    // Past the handoff deadline the detector has had its runs: it either
    // cancelled the booking (which removes it from this cohort) or decided not
    // to, and a booking neither job will claim must not exist.
    db.consultation.findMany.mockResolvedValue([
      consultation(NO_SHOW_HANDOFF_MINUTES + 10, [CONSULTEE], "UNVERIFIED"),
    ]);

    const result = await autoCompleteAppointments();

    expect(result.consultationsCompleted).toBe(1);
  });

  it("does not complete a subscription with entitlement remaining (#1766)", async () => {
    // Cycle one of a 12-plan is delivered and nothing is live: the old sweep
    // flipped the request to COMPLETED (terminal) and stranded the other 8.
    const delivered = Array.from({ length: 4 }, (_, i) => ({
      startsAt: minutesAgo((5 - i) * 24 * 60),
      endsAt: minutesAgo((5 - i) * 24 * 60 - 60),
      completionStatus: "COMPLETED",
      isTentative: false,
      deletedAt: null,
    }));
    db.subscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        status: "APPROVED",
        sessionsTotal: 12,
        schedulingPeriodStartsAt: minutesAgo(6 * 24 * 60),
        schedulingTimezone: "UTC",
        subscriptionPlan: {
          title: "Intensive",
          totalSessions: 12,
          sessionsPerWeek: 4,
          durationInMonths: 3,
          consultantProfile: { userId: CONSULTANT, user: { name: "C" } },
        },
        requestedBy: { userId: CONSULTEE, user: { name: "B" } },
        appointment: {
          id: "apt-sub",
          organizationId: null,
          occurrences: delivered,
        },
      },
    ]);

    const result = await autoCompleteAppointments();

    expect(result.subscriptionsCompleted).toBe(0);
    expect(db.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("pauses the handoff clock while maintenance holds the detector (#1746 B)", () => {
    const ended = minutesAgo(NO_SHOW_HANDOFF_MINUTES + 30);
    const degraded = [{ startsAt: minutesAgo(200), endsAt: minutesAgo(100) }];
    expect(isPastNoShowHandoff(ended)).toBe(true);
    expect(isPastNoShowHandoff(ended, new Date(), degraded)).toBe(false);
  });

  it("hands over only after the hourly detector has seen the booking past its grace window", () => {
    expect(
      NO_SHOW_HANDOFF_MINUTES - NO_SHOW_GRACE_MINUTES,
    ).toBeGreaterThanOrEqual(HOURLY_MINUTES);
  });

  it.each(["not-final", "unavailable", "expired", "too-early"] as const)(
    "the detector neither refunds nor strikes while Stream's record is %s",
    async (kind) => {
      db.consultation.findMany.mockResolvedValue([
        consultation(NO_SHOW_GRACE_MINUTES + 30, [CONSULTEE]),
      ]);
      settlement.current = { kind };

      const result = await detectConsultantNoShows();

      expect(result).toMatchObject({ detected: 0, refunded: 0, unsettled: 1 });
      expect(refundBookingPayment).not.toHaveBeenCalled();
      expect(db.consultation.updateMany).not.toHaveBeenCalled();
      expect(db.systemEvent.create).not.toHaveBeenCalled();
      expect(reportStandingFinding).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ["cons-1"] }),
      );
    },
  );
});
