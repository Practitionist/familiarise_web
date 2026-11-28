/**
 * @jest-environment node
 */

/**
 * Confirming a trial reschedule moves the one released session in place onto
 * the proposal's single window and closes the proposal in the same
 * transaction; a consultant's proposal never auto-confirms; a window that is
 * not the trial's length, too soon, outside open hours or taken writes
 * nothing. Each side may move a trial once.
 */

const db = {
  request: null as Record<string, unknown> | null,
  refusal: null as null | "OUTSIDE_AVAILABILITY" | "SLOT_TAKEN",
  moved: 1,
};
const closeConfirmedProposal = jest.fn(async () => undefined);
const transitionOccurrenceCompletion = jest.fn(async () => db.moved);
const release = jest.fn(async () => undefined);
const lockTrialPick = jest.fn(async () => release);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    rescheduleRequest: { findUnique: jest.fn(async () => db.request) },
    consultantProfile: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ rescheduleRequest: { findUnique: jest.fn(async () => null) } }),
    ),
  },
}));
jest.mock("../../lib/booking/reschedule-confirm", () => ({
  closeConfirmedProposal: (...a: unknown[]) =>
    closeConfirmedProposal(...(a as [])),
}));
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: (...a: unknown[]) =>
    transitionOccurrenceCompletion(...(a as [])),
}));
jest.mock("../../lib/trials/book-trial", () => ({
  lockTrialPick: (...a: unknown[]) => lockTrialPick(...(a as [])),
  lockTrialPickInTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/trials/slot-check", () => ({
  trialWindowRefusal: jest.fn(async () => db.refusal),
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: jest.fn(
    async (_id: string, fn: (lock: unknown) => unknown) => fn({ key: "a" }),
  ),
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
  ConsulteeBookingBusyError: class extends Error {},
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentRescheduled: jest.fn(async () => []),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentRescheduledEmail: jest.fn(async () => []),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

import {
  confirmTrialProposal,
  proposedTrialWindow,
} from "../../lib/booking/trial-reschedule";
import {
  MAX_TRIAL_RESCHEDULES_PER_SIDE,
  trialCapReached,
} from "../../lib/booking/reschedule-caps";

const NOW = new Date("2026-11-10T08:00:00.000Z");
const NEW_START = new Date("2026-11-14T10:00:00.000Z");
const atom = (start: Date, i = 0) => ({
  startsAt: new Date(start.getTime() + i * 30 * 60_000),
  endsAt: new Date(start.getTime() + (i + 1) * 30 * 60_000),
});
const OLD_START = new Date("2026-11-12T10:00:00.000Z");
/** The released session, still at its booked times. */
const releasedSession = (minutes: number) => ({
  startsAt: OLD_START,
  endsAt: new Date(OLD_START.getTime() + minutes * 60_000),
  completionStatus: "RESCHEDULED",
  deletedAt: null,
});

function openRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "rr-1",
    status: "PENDING_REVIEW",
    expiresAt: new Date(NOW.getTime() + 48 * 3_600_000),
    initiatorRole: "CONSULTEE",
    appointmentId: "apt-1",
    releasedOccurrenceIds: ["occ-1"],
    proposedTimes: [atom(NEW_START)],
    appointment: {
      occurrences: [releasedSession(30)],
      trial: {
        consultantProfileId: "cp-1",
        consultantProfile: { userId: "u-expert" },
        consulteeProfile: { userId: "u-learner" },
        subscriptionPlan: { trialDurationMinutes: 30 },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.request = openRequest();
  db.refusal = null;
  db.moved = 1;
});

describe("proposedTrialWindow", () => {
  it("joins contiguous atoms into one window", () => {
    expect(
      proposedTrialWindow([atom(NEW_START, 1), atom(NEW_START, 0)]),
    ).toEqual({ startsAt: NEW_START, endsAt: atom(NEW_START, 1).endsAt });
  });
  it("refuses atoms with a gap", () => {
    expect(
      proposedTrialWindow([atom(NEW_START, 0), atom(NEW_START, 2)]),
    ).toBeNull();
  });
});

describe("confirmTrialProposal", () => {
  it("auto-confirms a consultee proposal: closes it and moves the session in place", async () => {
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: true });
    expect(closeConfirmedProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: { id: "rr-1" }, to: "AUTO_ACCEPTED" }),
    );
    expect(transitionOccurrenceCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["occ-1"] },
          appointmentId: "apt-1",
        }),
        to: "SCHEDULED",
        fromIn: ["RESCHEDULED"],
        data: {
          startsAt: NEW_START,
          endsAt: atom(NEW_START).endsAt,
          isTentative: false,
        },
      }),
    );
    expect(lockTrialPick).toHaveBeenCalledWith(
      expect.objectContaining({
        consulteeUserId: "u-learner",
        consultantProfileId: "cp-1",
        startsAt: NEW_START,
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("never auto-confirms a consultant's proposal", async () => {
    db.request = openRequest({ initiatorRole: "CONSULTANT" });
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: false, reason: "CONSULTANT_INITIATED" });
    expect(lockTrialPick).not.toHaveBeenCalled();
  });

  it("the consultee's Accept confirms a consultant's proposal", async () => {
    db.request = openRequest({ initiatorRole: "CONSULTANT" });
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "ACCEPTED",
      resolvedById: "u-learner",
      heldAppointmentLock: { key: "a" } as never,
      now: NOW,
    });
    expect(out).toEqual({ confirmed: true });
    expect(closeConfirmedProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "ACCEPTED",
        data: { resolvedById: "u-learner" },
      }),
    );
  });

  it("refuses a window that is not the trial's length", async () => {
    db.request = openRequest({
      proposedTimes: [atom(NEW_START, 0), atom(NEW_START, 1)],
    });
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: false, reason: "VALIDATION_FAILED" });
    expect(closeConfirmedProposal).not.toHaveBeenCalled();
  });

  it("validates the move at the booked session's length after the plan's length changes", async () => {
    const request = openRequest({
      proposedTimes: [atom(NEW_START, 0), atom(NEW_START, 1)],
    });
    // Sold at 60 minutes; the plan now offers 30.
    db.request = {
      ...request,
      appointment: {
        ...request.appointment,
        occurrences: [releasedSession(60)],
      },
    };
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: true });
  });

  it("refuses a new time inside the 24-hour reschedule lead", async () => {
    db.request = openRequest({
      proposedTimes: [atom(new Date(NOW.getTime() + 20 * 3_600_000))],
    });
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: false, reason: "TOO_CLOSE_TO_START" });
  });

  it.each([
    ["SLOT_TAKEN", "TIMES_TAKEN"],
    ["OUTSIDE_AVAILABILITY", "NO_AVAILABILITY"],
  ] as const)(
    "a %s window rolls back with %s and moves nothing",
    async (refusal, reason) => {
      db.refusal = refusal;
      const out = await confirmTrialProposal({
        rescheduleRequestId: "rr-1",
        to: "AUTO_ACCEPTED",
        now: NOW,
      });
      expect(out).toEqual(
        expect.objectContaining({ confirmed: false, reason }),
      );
      expect(transitionOccurrenceCompletion).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("a released row that is gone writes nothing (VALIDATION_FAILED)", async () => {
    db.moved = 0;
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: false, reason: "VALIDATION_FAILED" });
  });

  it("a busy consultee key answers APPOINTMENT_BUSY and moves nothing", async () => {
    const { ConsulteeBookingBusyError } = jest.requireMock(
      "../../utils/appointmentlock",
    );
    lockTrialPick.mockRejectedValueOnce(new ConsulteeBookingBusyError());
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "AUTO_ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: false, reason: "APPOINTMENT_BUSY" });
    expect(transitionOccurrenceCompletion).not.toHaveBeenCalled();
  });

  it("a lapsed proposal is not answerable", async () => {
    db.request = openRequest({ expiresAt: new Date(NOW.getTime() - 1) });
    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "ACCEPTED",
      now: NOW,
    });
    expect(out).toEqual({ confirmed: false, reason: "PROPOSAL_EXPIRED" });
  });
});

describe("a trial acceptance that reaches its commit after the deadline", () => {
  it.each(["ACCEPTED", "AUTO_ACCEPTED"] as const)(
    "%s: the closing write carries the deadline, and a miss on a still-open proposal answers PROPOSAL_EXPIRED",
    async (to) => {
      const { AllocationConflictError } = jest.requireActual(
        "../../utils/scheduling-engine/errors",
      );
      const reads = (
        jest.requireMock("../../lib/prisma") as {
          default: { rescheduleRequest: { findUnique: jest.Mock } };
        }
      ).default.rescheduleRequest.findUnique;
      // Open at the preflight; past its deadline, still unanswered, at the write.
      reads.mockResolvedValueOnce(openRequest()).mockResolvedValueOnce({
        status: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() - 1_000),
      });
      closeConfirmedProposal.mockRejectedValueOnce(
        new AllocationConflictError("closed", "RESCHEDULE_NO_LONGER_OPEN"),
      );
      const before = Date.now();

      const out = await confirmTrialProposal({
        rescheduleRequestId: "rr-1",
        to,
        now: NOW,
      });

      const [, write] = closeConfirmedProposal.mock.calls[0] as unknown as [
        unknown,
        { whereAnd?: { expiresAt: { gt: Date } } },
      ];
      expect(write.whereAnd?.expiresAt.gt.getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect(out).toEqual({ confirmed: false, reason: "PROPOSAL_EXPIRED" });
      expect(transitionOccurrenceCompletion).not.toHaveBeenCalled();
    },
  );

  it("a proposal someone else closed keeps its no-longer-open answer", async () => {
    const { AllocationConflictError } = jest.requireActual(
      "../../utils/scheduling-engine/errors",
    );
    const reads = (
      jest.requireMock("../../lib/prisma") as {
        default: { rescheduleRequest: { findUnique: jest.Mock } };
      }
    ).default.rescheduleRequest.findUnique;
    reads.mockResolvedValueOnce(openRequest()).mockResolvedValueOnce({
      status: "WITHDRAWN",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    closeConfirmedProposal.mockRejectedValueOnce(
      new AllocationConflictError("closed", "RESCHEDULE_NO_LONGER_OPEN"),
    );

    const out = await confirmTrialProposal({
      rescheduleRequestId: "rr-1",
      to: "ACCEPTED",
      now: NOW,
    });

    expect(out).toEqual({
      confirmed: false,
      reason: "RESCHEDULE_NO_LONGER_OPEN",
    });
  });
});

describe("trial reschedule caps", () => {
  it("each side moves a trial once", () => {
    expect(MAX_TRIAL_RESCHEDULES_PER_SIDE).toBe(1);
    expect(trialCapReached({ total: 0, byOrdinal: new Map() })).toBe(false);
    expect(trialCapReached({ total: 1, byOrdinal: new Map([[1, 1]]) })).toBe(
      true,
    );
  });
});
