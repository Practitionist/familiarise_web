/**
 * @jest-environment node
 */

/**
 * P0 — a reschedule long enough to need more than one atom, and a decline that
 * no longer strands a paid booking in the refunding sweeps' cohort.
 *
 * Two production defects with the same shape: a count in one unit compared
 * against a count in another, and a "no decision is a decision" assumption.
 *
 * - The proposal's count check compared whole released OCCURRENCES against
 *   single-atom PROPOSED rows, so any session longer than 30 minutes could be
 *   released and proposed but never accepted: the shape the calendar actually
 *   sends (a click expands to `slotsPerSession` atoms) failed the check, and
 *   the shape that passed it was refused downstream by the allocator's
 *   multiples-of-`slotsPerCall` rule. The invariant is EQUAL COVERAGE, measured
 *   in atoms on both sides.
 *
 * - A decline was a status transition and nothing else, which left the parent
 *   in the PENDING that `expireUnallocatedPaidSubscriptions` selects: paid,
 *   zero live sessions, no open proposal. The decline is what removed the
 *   proposal from that cohort, so a consultant saying "no, not that time" ended
 *   with the platform refunding the buyer in full 48 hours later.
 *
 * State-based prisma mock (the `reschedule-withdraw-behavior` idiom): the tx
 * stub mutates an in-memory store so the CAS guards run for real through the
 * mocked updateMany counts, and the restore miss is produced by making the
 * occurrence write raise the real exclusion violation rather than by stubbing
 * the restore itself.
 */

import "./setup";

interface SlotRow {
  id: string;
  isTentative: boolean;
  completionStatus: string;
  startsAt: Date;
  endsAt: Date;
  deletedAt: Date | null;
}

interface NotifyRow {
  appointment: {
    id: string;
    organizationId: string | null;
    appointmentType: string;
    consultation: unknown;
    subscription: unknown;
  };
}

interface Store {
  request: {
    id: string;
    status: string;
    initiatedById: string;
    releasedOccurrenceIds: string[];
    appointmentId: string;
    openForAppointmentId: string | null;
    createdAt: Date;
    appointment: { consultationId: string | null; subscriptionId: string | null };
  };
  slots: SlotRow[];
  consultation: { id: string; status: string } | null;
  subscription: { id: string; status: string } | null;
  /** The from-status on the reschedule's PENDING re-stamp; undefined = no row. */
  origin?: string;
  notify: NotifyRow;
}

let state: Store;

type Data = Record<string, unknown>;
interface StatusCas {
  where: { id: string; status?: { in: string[] } };
  data: Data;
}
interface SlotCas {
  where: { id?: { in: string[] }; completionStatus: { in: string[] } };
  data: Data;
}

function matchSlots(where: SlotCas["where"]): SlotRow[] {
  return state.slots.filter(
    (s) =>
      (!where.id || where.id.in.includes(s.id)) &&
      where.completionStatus.in.includes(s.completionStatus),
  );
}

function makeTx() {
  return {
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
      // #1589 R-P1-01 — the origin read: the row the reschedule route wrote.
      findFirst: jest.fn(async () =>
        state.origin === undefined ? null : { fromStatus: state.origin },
      ),
    },
    rescheduleRequest: {
      findUnique: jest.fn(async () => state.request),
      updateMany: jest.fn(async ({ where, data }: StatusCas) => {
        const row = state.request;
        if (!row || row.id !== where.id) return { count: 0 };
        // The CAS: the from-set is the state machine.
        if (where.status?.in && !where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async ({ where }: SlotCas) =>
        matchSlots(where).map((s) => ({
          id: s.id,
          completionStatus: s.completionStatus,
        })),
      ),
      updateManyAndReturn: jest.fn(async ({ where, data }: SlotCas) => {
        const targets = matchSlots(where);
        targets.forEach((s) => Object.assign(s, data));
        return targets.map((s) => ({ id: s.id }));
      }),
    },
    consultation: {
      findUnique: jest.fn(async () => state.consultation ?? null),
      updateMany: jest.fn(async ({ where, data }: StatusCas) => {
        const row = state.consultation;
        if (!row || row.id !== where.id) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    subscription: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        state.subscription && state.subscription.id === where.id
          ? { status: state.subscription.status }
          : null,
      ),
      updateMany: jest.fn(async ({ where, data }: StatusCas) => {
        const row = state.subscription;
        if (!row || row.id !== where.id) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
}

let tx: ReturnType<typeof makeTx>;

/**
 * The four mutable rows a transaction can move. Copied on entry and put back
 * on a throw, so a rolled-back transaction leaves the store exactly as Prisma
 * would — without it the "the restore failed so nothing moved" assertions would
 * pass on the mutations the failed transaction left behind.
 */
function snapshot() {
  return {
    request: { ...state.request },
    slots: state.slots.map((s) => ({ ...s })),
    consultation: state.consultation ? { ...state.consultation } : null,
    subscription: state.subscription ? { ...state.subscription } : null,
  };
}

function rollback(saved: ReturnType<typeof snapshot>) {
  state.request = saved.request;
  state.slots = saved.slots;
  state.consultation = saved.consultation;
  state.subscription = saved.subscription;
}

/** Run one transaction on a fresh tx stub, restoring the store if it throws. */
async function runTransaction(fn: (t: ReturnType<typeof makeTx>) => unknown) {
  const saved = snapshot();
  tx = makeTx();
  try {
    return await fn(tx);
  } catch (err) {
    rollback(saved);
    throw err;
  }
}

/** The exclusion violation the real restore meets, in Prisma's P2010 shape. */
const OVERLAP_VIOLATION = Object.assign(
  new Error(
    "ERROR: 23P01: conflicting key value violates exclusion constraint occurrence_no_confirmed_overlap",
  ),
  { code: "P2010", meta: { code: "23P01" } },
);

const mockPrisma = {
  rescheduleRequest: {
    findUnique: jest.fn(async (): Promise<unknown> => null),
  },
  appointmentOccurrence: {
    findFirst: jest.fn(async (): Promise<unknown> => null),
  },
  $transaction: jest.fn((fn: (t: unknown) => unknown) => runTransaction(fn)),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../utils/scheduling-engine/SchedulingService", () => ({
  SchedulingService: { allocate: jest.fn() },
}));

const reportSentryError = jest.fn();
const reportSentryMessage = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
  reportSentryMessage: (...args: unknown[]) => reportSentryMessage(...args),
}));

const recordSystemErrorSafe = jest.fn().mockResolvedValue(undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemErrorSafe: (...args: unknown[]) => recordSystemErrorSafe(...args),
}));

const withAppointmentLock = jest.fn(
  (_appointmentId: string, fn: () => unknown) => fn(),
);
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: (...args: [string, () => unknown]) =>
    withAppointmentLock(...args),
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
}));

jest.mock("../../lib/email", () => ({
  __esModule: true,
  EMAIL_BUDGET_MS: { REQUEST: 250, JOB: 250 },
  sendAppointmentRescheduledEmail: jest.fn().mockResolvedValue(undefined),
}));

import {
  proposedAtomCount,
  proposalCoverageMatches,
  releasedAtomCount,
  rescheduleProposeOutcome,
} from "../../lib/booking/reschedule-proposals";
import { declineProposal } from "../../lib/booking/reschedule-respond";
import { notifyAppointmentRescheduled } from "../../lib/novu";

const ATOM = 30 * 60 * 1000;
const INITIATOR = "user-consultee";
const CONSULTANT = "user-consultant";
const FIRST_SESSION = "2026-10-01T09:00:00.000Z";

const at = (iso: string) => new Date(iso);

/** One released occurrence `atoms` long — a whole session, not one atom. */
function session(id: string, atoms: number, startIso = FIRST_SESSION): SlotRow {
  const startsAt = at(startIso);
  return {
    id,
    isTentative: true,
    completionStatus: "RESCHEDULED",
    startsAt,
    endsAt: new Date(startsAt.getTime() + atoms * ATOM),
    deletedAt: null,
  };
}

/** The atom rows the calendar expands one click into. */
function atomRows(count: number) {
  const first = at("2026-10-08T09:00:00.000Z").getTime();
  return Array.from({ length: count }, (_, i) => ({
    startsAt: new Date(first + i * ATOM),
    endsAt: new Date(first + (i + 1) * ATOM),
  }));
}

/** The two 1:1 sides, as the notification readers see them. */
function consultationSide() {
  return {
    requestedBy: { user: { id: INITIATOR, name: "Consultee" } },
    consultationPlan: {
      title: "Plan",
      consultantProfile: { user: { id: CONSULTANT, name: "Consultant" } },
    },
  };
}

function seed(
  overrides: Partial<{
    slots: SlotRow[];
    consultationId: string | null;
    subscriptionId: string | null;
    consultationStatus: string;
    subscriptionStatus: string;
    origin: string;
    requestStatus: string;
  }> = {},
) {
  const slots = overrides.slots ?? [session("slot-1", 2)];
  const consultationId =
    overrides.consultationId === undefined
      ? "cons-1"
      : overrides.consultationId;
  const subscriptionId = overrides.subscriptionId ?? null;
  const releasedOccurrenceIds = slots.map((s) => s.id);

  state = {
    request: {
      id: "req-1",
      status: overrides.requestStatus ?? "PENDING_REVIEW",
      initiatedById: INITIATOR,
      releasedOccurrenceIds,
      appointmentId: "appt-1",
      openForAppointmentId: "appt-1",
      createdAt: at("2026-09-19T10:00:00Z"),
      appointment: { consultationId, subscriptionId },
    },
    slots,
    // The common case: the request was APPROVED when the reschedule opened.
    origin: overrides.origin === undefined ? "APPROVED" : overrides.origin,
    consultation: consultationId
      ? {
          id: consultationId,
          status: overrides.consultationStatus ?? "PENDING",
        }
      : null,
    subscription: subscriptionId
      ? {
          id: subscriptionId,
          status: overrides.subscriptionStatus ?? "PENDING",
        }
      : null,
    notify: {
      appointment: {
        id: "appt-1",
        organizationId: null,
        appointmentType: consultationId ? "CONSULTATION" : "SUBSCRIPTION",
        consultation: consultationId ? consultationSide() : null,
        subscription: subscriptionId
          ? {
              requestedBy: { user: { id: INITIATOR, name: "Consultee" } },
              subscriptionPlan: {
                title: "Plan",
                consultantProfile: {
                  user: { id: CONSULTANT, name: "Consultant" },
                },
              },
            }
          : null,
      },
    },
  };

  mockPrisma.rescheduleRequest.findUnique.mockImplementation(async () => ({
    // The decline reads this row twice off two different selects — once for
    // the restore fields, once for the notification side — so the mock answers
    // with their union, as one row would.
    ...state.request,
    appointment: {
      consultationId,
      subscriptionId,
      ...state.notify.appointment,
    },
  }));
  mockPrisma.appointmentOccurrence.findFirst.mockImplementation(
    async ({ where }: { where: { id: { in: string[] }; completionStatus?: string } }) => {
      const hit = state.slots
        .filter(
          (s) =>
            where.id.in.includes(s.id) &&
            s.deletedAt === null &&
            (where.completionStatus === undefined ||
              s.completionStatus === where.completionStatus),
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
      return hit ? { startsAt: hit.startsAt } : null;
    },
  );

  reportSentryError.mockClear();
  reportSentryMessage.mockClear();
  recordSystemErrorSafe.mockClear();
  withAppointmentLock.mockClear();
  (notifyAppointmentRescheduled as jest.Mock).mockClear();
  // A miss is the exception, not the default: every other suite in this file
  // needs the plain write.
  mockPrisma.$transaction.mockImplementation((fn) => runTransaction(fn));
}

/** The `-partial` reports, so a clean restore can be asserted as silent. */
function partialRestoreReports() {
  return reportSentryError.mock.calls
    .filter(
      ([, meta]) =>
        (meta as { op?: string } | undefined)?.op ===
        "reschedule-decline-partial",
    )
    .map(([err]) => (err as Error).message);
}

function decline() {
  return declineProposal({
    rescheduleRequestId: "req-1",
    resolvedById: CONSULTANT,
  });
}

describe("a proposal replaces the coverage it released, counted in atoms", () => {
  it("accepts a 1-hour session proposed as the two atoms a click expands to", () => {
    // The production shape: ONE released occurrence covering two atoms against
    // TWO proposed rows. The row-count check refused this, and the allocator
    // separately demands multiples of slotsPerCall — so no proposal for a
    // session over 30 minutes could ever be accepted or auto-confirmed.
    expect(releasedAtomCount([session("s", 2)])).toBe(2);
    expect(proposedAtomCount(atomRows(2))).toBe(2);
    expect(proposalCoverageMatches([session("s", 2)], atomRows(2))).toBe(true);
  });

  it("still accepts a 30-minute session proposed as one atom", () => {
    expect(proposalCoverageMatches([session("s", 1)], atomRows(1))).toBe(true);
  });

  it("rejects a proposal that does not cover the same total time", () => {
    // Half a session proposed for a whole one is a different booking, and so is
    // more of one: either would change what was paid for.
    expect(proposalCoverageMatches([session("s", 2)], atomRows(1))).toBe(false);
    expect(proposalCoverageMatches([session("s", 1)], atomRows(2))).toBe(false);
  });

  it("sums across sessions rather than counting rows", () => {
    // Three 1-hour sessions are three rows and six atoms; a two-row payload
    // cannot replace them, and a six-row one can.
    const released = [
      session("a", 2, "2026-10-01T09:00:00.000Z"),
      session("b", 2, "2026-10-08T09:00:00.000Z"),
      session("c", 2, "2026-10-15T09:00:00.000Z"),
    ];
    expect(releasedAtomCount(released)).toBe(6);
    expect(proposalCoverageMatches(released, atomRows(6))).toBe(true);
    expect(proposalCoverageMatches(released, atomRows(2))).toBe(false);
  });

  it("measures both sides from their own bounds, including a degenerate one", () => {
    // An inverted window must not make the released side look SHORTER than a
    // real one and wave a proposal through.
    expect(
      releasedAtomCount([
        { startsAt: at("2026-10-08T10:00:00Z"), endsAt: at("2026-10-08T09:00:00Z") },
      ]),
    ).toBe(0);
    // A row one millisecond short is still one atom — a stray millisecond must
    // not refuse a proposal the allocator would have accepted.
    expect(
      proposedAtomCount([
        {
          startsAt: at("2026-10-08T09:00:00.000Z"),
          endsAt: new Date(at("2026-10-08T09:30:00.000Z").getTime() - 1),
        },
      ]),
    ).toBe(1);
  });

  it("treats nothing released as nothing proposed", () => {
    expect(proposalCoverageMatches([], [])).toBe(true);
    expect(proposalCoverageMatches([], atomRows(1))).toBe(false);
  });
});

describe("the propose response's outcome code", () => {
  const base = {
    hasProposal: true,
    releaseMessage: "All sessions marked for rescheduling.",
  };

  it("names a confirmed move", () => {
    expect(
      rescheduleProposeOutcome({
        ...base,
        autoConfirmed: true,
        autoConfirmReason: null,
      }),
    ).toEqual({ code: "AUTO_CONFIRMED", message: "Your new time is confirmed." });
  });

  it("falls back to the route's own sentence when no times were named", () => {
    expect(
      rescheduleProposeOutcome({
        ...base,
        hasProposal: false,
        autoConfirmed: false,
        autoConfirmReason: null,
      }),
    ).toEqual({ code: "RELEASED", message: base.releaseMessage });
  });

  it("keeps the consultant sentence for a consultant's own proposal", () => {
    // Auto-confirm is asymmetric on purpose: a consultant-initiated proposal
    // NEVER confirms without the consultee, so this is "waiting", not a failure
    // to place the times.
    expect(
      rescheduleProposeOutcome({
        ...base,
        autoConfirmed: false,
        autoConfirmReason: "CONSULTANT_INITIATED",
      }).code,
    ).toBe("AWAITING_ANSWER");
  });

  it("keeps the consultant sentence when the attempt never got to decide", () => {
    for (const reason of [
      "APPOINTMENT_BUSY",
      "BOOKING_LOCK_UNAVAILABLE",
      "ERROR",
    ]) {
      expect(
        rescheduleProposeOutcome({
          ...base,
          autoConfirmed: false,
          autoConfirmReason: reason,
        }).code,
      ).toBe("AWAITING_ANSWER");
    }
    // No reason at all: auto-confirm was never attempted.
    expect(
      rescheduleProposeOutcome({
        ...base,
        autoConfirmed: false,
        autoConfirmReason: null,
      }).code,
    ).toBe("AWAITING_ANSWER");
  });

  it("does not claim the consultant will confirm a time we already refused", () => {
    // The fixed sentence asserted a human action for a refusal the server had
    // just detected — a taken slot, no availability, a stale tentative count.
    for (const reason of [
      "SLOT_TAKEN",
      "NO_AVAILABILITY",
      "SLOT_SHORTAGE",
      "RESCHEDULE_STATE_CHANGED",
      "VALIDATION_FAILED",
    ]) {
      const out = rescheduleProposeOutcome({
        ...base,
        autoConfirmed: false,
        autoConfirmReason: reason,
      });
      expect(out.code).toBe("NOT_PLACEABLE");
      expect(out.message).not.toContain("sent to the consultant");
    }
  });

  it("says the request is gone when the row no longer is", () => {
    // The one arm the response previously had no word for: a proposal that was
    // answered, expired, or lost its finalize race is waiting on nobody.
    for (const reason of [
      "PROPOSAL_NOT_OPEN",
      "PROPOSAL_NOT_FOUND",
      "TRANSITION_REFUSED",
    ]) {
      expect(
        rescheduleProposeOutcome({
          ...base,
          autoConfirmed: false,
          autoConfirmReason: reason,
        }).code,
      ).toBe("PROPOSAL_CLOSED");
    }
  });
});

describe("a decline restores the booking it declined to move", () => {
  it("puts every released session back and the parent back to its origin", async () => {
    seed();

    expect(await decline()).toEqual({ done: true });
    // The released rows carry their original times, so restoring is two flags.
    expect(state.slots).toEqual([
      expect.objectContaining({
        id: "slot-1",
        isTentative: false,
        completionStatus: "SCHEDULED",
      }),
    ]);
    // The parent must leave PENDING — that is the state the refunded sweeps
    // select — and the origin for a paid booking is APPROVED.
    expect(state.consultation?.status).toBe("APPROVED");
    expect(state.request.status).toBe("DECLINED");
    // A lifecycle mutation, so it serialises on the appointment atom.
    expect(withAppointmentLock).toHaveBeenCalledWith(
      "appt-1",
      expect.any(Function),
    );
    // A full restore is not an anomaly, so nothing is reported.
    expect(partialRestoreReports()).toEqual([]);
    expect(recordSystemErrorSafe).not.toHaveBeenCalled();
  });

  it("restores a whole subscription's released sessions too", async () => {
    seed({
      consultationId: null,
      subscriptionId: "sub-1",
      slots: [session("s1", 2), session("s2", 1, "2026-10-08T09:00:00.000Z")],
    });

    expect(await decline()).toEqual({ done: true });
    expect(state.slots.map((s) => s.completionStatus)).toEqual([
      "SCHEDULED",
      "SCHEDULED",
    ]);
    expect(state.subscription?.status).toBe("APPROVED");
  });

  it("tells the counterparty their original time is back", async () => {
    seed();

    await decline();

    expect(notifyAppointmentRescheduled).toHaveBeenCalledWith(
      expect.arrayContaining([INITIATOR, CONSULTANT]),
      expect.objectContaining({
        outcome: "DECLINED",
        oldDateTime: at(FIRST_SESSION).toISOString(),
      }),
    );
  });

  it("leaves an unpaid APPROVED_PENDING_PAYMENT parent unpaid", async () => {
    // Promoting it to APPROVED would be a payment bypass; the pay-link expiry
    // cohort owns that shape, and it holds no money.
    seed({ origin: "APPROVED_PENDING_PAYMENT" });

    await decline();

    expect(state.consultation?.status).toBe("APPROVED_PENDING_PAYMENT");
  });

  it("answers PROPOSAL_NOT_OPEN when the proposal was already answered", async () => {
    seed({ requestStatus: "ACCEPTED" });

    expect(await decline()).toEqual({ done: false, reason: "PROPOSAL_NOT_OPEN" });
    // Nothing un-released out from under the accept.
    expect(state.slots[0].completionStatus).toBe("RESCHEDULED");
  });
});

describe("a decline whose original time is gone parks instead of failing", () => {
  /**
   * The exclusion violation the real restore meets: the consultant's original
   * time was booked by someone else while the proposal was open, so flipping
   * the released row back to confirmed hits `occurrence_no_confirmed_overlap`.
   * Installed on the transaction stub, which is rebuilt per transaction, rather
   * than on the restore helper — so the miss is produced by the write the
   * restore actually makes, and the store is rolled back with it.
   */
  async function seedWithOverlappingClaim() {
    seed();
    mockPrisma.$transaction.mockImplementation(async (fn) => {
      const saved = snapshot();
      tx = makeTx();
      tx.appointmentOccurrence.updateManyAndReturn.mockImplementation(() => {
        throw OVERLAP_VIOLATION;
      });
      try {
        return await fn(tx);
      } catch (err) {
        rollback(saved);
        throw err;
      }
    });
  }

  it("still ends the request DECLINED", async () => {
    await seedWithOverlappingClaim();

    expect(await decline()).toEqual({ done: true });
    expect(state.request.status).toBe("DECLINED");
    // The restore rolled back with its transaction, so the sessions really are
    // still released — this is the stranded case, not a clean decline.
    expect(state.slots[0].completionStatus).toBe("RESCHEDULED");
    // A decision stands: re-offering the proposal because the old time is gone
    // would ask the same person the same question again.
  });

  it("takes the parent out of the shape the refunding sweep selects", async () => {
    // THE money bug. PENDING + zero live sessions + no open proposal + a
    // payment captured over 48h ago is `expireUnallocatedPaidSubscriptions`,
    // which refunds the plan in full. A DECLINED proposal is no longer open, so
    // the decline is exactly what made the booking match that cohort.
    await seedWithOverlappingClaim();

    await decline();

    expect(state.consultation?.status).toBe("APPROVED");
    expect(state.consultation?.status).not.toBe("PENDING");
  });

  it("leaves a durable trace an operator can query", async () => {
    // `reportSentryError` alone evaporates; the SystemEvent row is what makes
    // "this booking still owes the buyer sessions" findable a week later.
    await seedWithOverlappingClaim();

    await decline();

    expect(recordSystemErrorSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "RESCHEDULE",
        context: expect.objectContaining({
          rescheduleRequestId: "req-1",
          appointmentId: "appt-1",
          parkedStatus: "APPROVED",
        }),
      }),
    );
  });

  it("tells the counterparty the time is gone rather than claiming it stands", async () => {
    await seedWithOverlappingClaim();

    await decline();

    // DECLINED's copy asserts the original time is kept, so a stranded booking
    // must not be sent that arm.
    expect(notifyAppointmentRescheduled).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ outcome: "RELEASED" }),
    );
  });

  it("does not report a clean restore on the path that had none", async () => {
    await seedWithOverlappingClaim();

    await decline();

    expect(partialRestoreReports()).toEqual([]);
  });
});
