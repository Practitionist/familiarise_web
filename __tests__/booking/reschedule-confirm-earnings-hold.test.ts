/**
 * @jest-environment node
 */

// Invariant: the reallocation buffer lasts only while a proposal is open. A
// confirmed move (auto-confirm or the other side's accept) leaves every PENDING
// earning held until the new session's end plus the type's hold hours.

const mockAllocate = jest.fn();
const mockRequestFindUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    rescheduleRequest: {
      findUnique: (...a: unknown[]) => mockRequestFindUnique(...a),
    },
    // The accept's post-commit notice reads; nothing to tell here.
    appointmentOccurrence: { findFirst: async () => null },
  },
}));
jest.mock("../../lib/booking/allocation", () => ({
  allocate: (...a: unknown[]) => mockAllocate(...a),
}));
jest.mock("../../lib/booking/backup-interest", () => ({
  stageNoticesForFreedWindows: jest.fn(async () => undefined),
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyAppointmentRescheduled: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  EMAIL_BUDGET_MS: { REQUEST: 250, JOB: 250 },
  sendAppointmentRescheduledEmail: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../utils/appointmentlock", () => ({
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
  withAppointmentLock: (_id: string, fn: (lock: unknown) => unknown) =>
    fn({ key: "appointment-lock:appt-1" }),
}));

import { tryAutoConfirmProposal } from "@/lib/booking/reschedule-auto-confirm";
import { acceptProposal } from "@/lib/booking/reschedule-respond";
import { resolveConsumedPreferenceRequests } from "@/lib/booking/allocation/preference";
import type { Tx } from "@/lib/prisma";
import type { ApprovalLock } from "@/utils/appointmentlock";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const capturedAt = new Date("2026-11-20T08:00:00.000Z");
const oldStart = new Date("2026-12-02T03:30:00.000Z");
const oldEnd = new Date("2026-12-02T04:30:00.000Z");
const newStart = new Date("2026-12-02T11:30:00.000Z");
const newEnd = new Date("2026-12-02T12:30:00.000Z");
/** What the route stamped when the proposal opened: old end + 7 days + 48 h. */
const buffered = new Date(oldEnd.getTime() + 7 * DAY + 48 * HOUR);
/** What the live session implies once the move is confirmed. */
const confirmed = new Date(newEnd.getTime() + 48 * HOUR);

type EarningRow = {
  id: string;
  status: "PENDING" | "READY" | "PAID" | "HELD";
  holdUntil: Date | null;
  createdAt: Date;
  cycleOrdinal: number | null;
  consultantProfileId?: string;
};

type EarningsWhere = {
  id?: string;
  paymentId?: { in: string[] };
  status?: string;
  holdUntil?: Date | { not: null };
  cycleOrdinal?: null;
};

function earningsTable(rows: EarningRow[]) {
  const matches = (row: EarningRow, where: EarningsWhere) =>
    (where.id === undefined || row.id === where.id) &&
    (where.status === undefined || row.status === where.status) &&
    (where.cycleOrdinal === undefined || row.cycleOrdinal === null) &&
    (where.holdUntil === undefined ||
      (where.holdUntil instanceof Date
        ? row.holdUntil?.getTime() === where.holdUntil.getTime()
        : row.holdUntil !== null));
  return {
    rows,
    findMany: jest.fn(async ({ where }: { where: EarningsWhere }) =>
      rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: EarningsWhere;
        data: { holdUntil: Date };
      }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) row.holdUntil = data.holdUntil;
        return { count: hit.length };
      },
    ),
  };
}

/** The confirming transaction after the allocator placed the new session. */
function confirmingTx() {
  const consultant = earningsTable(
    (["PENDING", "READY", "PAID", "HELD"] as const).map((status) => ({
      id: `ce-${status}`,
      status,
      holdUntil: buffered,
      createdAt: capturedAt,
      cycleOrdinal: null,
      consultantProfileId: "cp-1",
    })),
  );
  const org = earningsTable([
    {
      id: "oe-PENDING",
      status: "PENDING",
      holdUntil: buffered,
      createdAt: capturedAt,
      cycleOrdinal: null,
    },
    {
      id: "oe-READY",
      status: "READY",
      holdUntil: buffered,
      createdAt: capturedAt,
      cycleOrdinal: null,
    },
  ]);
  const tx = {
    rescheduleRequest: {
      findUnique: jest.fn(async () => ({
        status: "PENDING_REVIEW",
        appointmentId: "appt-1",
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      // The open request the expert's placement answers, as its select reads it.
      findMany: jest.fn(async () => [
        {
          id: "req-2",
          initiatorRole: "CONSULTEE",
          appointmentId: "appt-1",
          _count: { proposedTimes: 0 },
        },
      ]),
    },
    bookingStatusHistory: { create: jest.fn(async () => ({})) },
    // The select restoreEarningsHold reads.
    appointment: {
      findUnique: jest.fn(async () => ({
        appointmentType: "CONSULTATION",
        payment: [{ id: "pay-1" }],
      })),
    },
    // The released row is gone; the new session is the last live one.
    appointmentOccurrence: {
      findFirst: jest.fn(async () => ({ endsAt: newEnd })),
    },
    consultantEarnings: {
      ...consultant,
      // An established expert: no new-expert days on top.
      findFirst: jest.fn(async () => ({
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      })),
      aggregate: jest.fn(async () => ({
        _sum: { consultantSharePaise: 100_000_000, refundedShareAmount: 0 },
      })),
    },
    organizationEarnings: org,
  };
  return { tx, consultant: consultant.rows, org: org.rows };
}

function holds(rows: EarningRow[]) {
  return Object.fromEntries(rows.map((r) => [r.id, r.holdUntil]));
}

let state = confirmingTx();
beforeEach(() => {
  state = confirmingTx();
  mockAllocate.mockImplementation(
    async (args: {
      inTx?: (tx: unknown, moved: unknown) => Promise<void>;
      checkOnly?: boolean;
    }) => {
      await args.inTx?.(state.tx, {
        consultantProfileId: "cp-1",
        freedWindows: [],
        placed: [],
      });
      return { success: true };
    },
  );
});

const settled = {
  "ce-PENDING": confirmed,
  "ce-READY": buffered,
  "ce-PAID": buffered,
  "ce-HELD": buffered,
};

describe("a confirmed reschedule releases the reallocation buffer", () => {
  it("auto-confirm: PENDING consultant and organisation holds become new end + 48 h; settled rows keep theirs", async () => {
    mockRequestFindUnique.mockResolvedValue({
      id: "req-1",
      appointmentId: "appt-1",
      initiatorRole: "CONSULTEE",
      initiatedById: "buyer-1",
      status: "PENDING_REVIEW",
      releasedOccurrenceIds: ["occ-old"],
      releasedSessions: [{ ordinal: 1, startsAt: oldStart.toISOString() }],
      proposedTimes: [{ startsAt: newStart, endsAt: newEnd }],
    });
    jest.useFakeTimers({
      now: new Date("2026-11-25T00:00:00.000Z"),
      doNotFake: ["nextTick", "setImmediate"],
    });
    try {
      expect(
        await tryAutoConfirmProposal("req-1", "consultation", "cons-1"),
      ).toEqual({ confirmed: true });
    } finally {
      jest.useRealTimers();
    }
    expect(holds(state.consultant)).toEqual(settled);
    expect(holds(state.org)).toEqual({
      "oe-PENDING": confirmed,
      "oe-READY": buffered,
    });
  });

  it("manual accept: the same holds as an auto-confirmed move", async () => {
    mockRequestFindUnique.mockResolvedValue({
      id: "req-1",
      appointmentId: "appt-1",
      status: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + DAY),
      proposedTimes: [{ startsAt: newStart }],
    });
    expect(
      await acceptProposal({
        rescheduleRequestId: "req-1",
        eventType: "consultation",
        eventId: "cons-1",
        resolvedById: "consultant-1",
        heldAppointmentLock: { key: "lock" } as ApprovalLock,
      }),
    ).toEqual({ done: true });
    expect(holds(state.consultant)).toEqual(settled);
    expect(holds(state.org)).toEqual({
      "oe-PENDING": confirmed,
      "oe-READY": buffered,
    });
  });

  it("the expert placing times over an open request: the same holds once it is consumed", async () => {
    await resolveConsumedPreferenceRequests(state.tx as unknown as Tx, [
      "occ-old",
    ]);
    expect(state.tx.rescheduleRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACCEPTED" }),
      }),
    );
    expect(holds(state.consultant)).toEqual(settled);
    expect(holds(state.org)).toEqual({
      "oe-PENDING": confirmed,
      "oe-READY": buffered,
    });
  });

  it("a proposal that waits for the other side keeps the buffer", async () => {
    mockRequestFindUnique.mockResolvedValue({
      id: "req-1",
      appointmentId: "appt-1",
      initiatorRole: "CONSULTEE",
      initiatedById: "buyer-1",
      status: "PENDING_REVIEW",
      releasedOccurrenceIds: ["occ-old"],
      releasedSessions: [{ ordinal: 1, startsAt: oldStart.toISOString() }],
      proposedTimes: [{ startsAt: newStart, endsAt: newEnd }],
    });
    jest.useFakeTimers({
      now: new Date(newStart.getTime() - 3 * HOUR),
      doNotFake: ["nextTick", "setImmediate"],
    });
    try {
      expect(
        await tryAutoConfirmProposal("req-1", "consultation", "cons-1"),
      ).toEqual({ confirmed: false, reason: "NEEDS_ACCEPTANCE" });
    } finally {
      jest.useRealTimers();
    }
    expect(mockAllocate).not.toHaveBeenCalled();
    expect(state.consultant.every((r) => r.holdUntil === buffered)).toBe(true);
    expect(state.org.every((r) => r.holdUntil === buffered)).toBe(true);
  });
});
