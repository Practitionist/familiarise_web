/**
 * @jest-environment node
 */

// Invariant: a negative verdict is confirmed once, by CAS from null: by the
// window-close pass on strong evidence after 48 hours, by the ops confirm door
// (which leaves outcomeAt alone), or as ops write it. A weak one stays
// unconfirmed on the needs-human list.

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  return {
    __esModule: true,
    default: {
      appointmentOccurrence: memTable([], "occ"),
      maintenanceWindow: memTable([], "mw"),
      platformIncident: memTable([], "pi"),
      refund: memTable([], "rf"),
      bookingStatusHistory: memTable([], "h"),
    },
  };
});
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: jest.fn(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  ),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  readJobCheckpoint: jest.fn(async () => null),
}));
jest.mock("../../lib/booking/class-sessions", () => ({
  onClassSessionVoided: jest.fn(),
}));

import prisma, { type Tx } from "@/lib/prisma";
import { matchesWhere, type memTable, type Row } from "../fixtures/mem-db";
import {
  needsHumanWhere,
  OUTCOME_REPORT_WINDOW_HOURS,
  UNCONFIRMED_LEARNER_ABSENT,
  unconfirmedClosedVerdictWhere,
} from "@/lib/booking/misses";
import {
  confirmClosedOutcomes,
  OUTAGE_READ_CAP,
} from "@/lib/booking/session-outcome-sweep";
import {
  confirmSessionOutcome,
  setSessionOutcome,
} from "@/lib/backoffice/session-outcomes";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import { readJobCheckpoint } from "@/lib/cron/with-cron-lock";

type Table = ReturnType<typeof memTable>;
const occurrences = prisma.appointmentOccurrence as unknown as Table;

const NOW = new Date("2026-11-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const START = hoursAgo(60);
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

/** A row in the shape the pass's select returns: host "hannah" waited the hour, learner "priya" never came. */
function verdict(id: string, overrides: Row = {}, meeting: Row = {}): Row {
  return {
    id,
    appointmentId: `apt-${id}`,
    deletedAt: null,
    isTentative: false,
    startsAt: at(0),
    endsAt: at(60),
    completionStatus: "COMPLETED",
    outcome: "LEARNER_ABSENT",
    outcomeAt: hoursAgo(50),
    outcomeConfirmedAt: null,
    meeting: {
      endedAt: at(62),
      endedReason: "session_timeout",
      attendanceSettledAt: hoursAgo(51),
      attendanceCorroboratedSessionIds: [],
      presences: [{ userId: "hannah", joinedAt: at(0), leftAt: at(60) }],
      ...meeting,
    },
    appointment: {
      subscriptionId: null,
      consultation: {
        consultationPlan: { consultantProfile: { userId: "hannah" } },
      },
      subscription: null,
      trial: null,
      webinar: null,
      class: null,
    },
    ...overrides,
  };
}

const row = (id: string) => occurrences.rows.find((r) => r.id === id)!;
const tx = prisma as unknown as Tx;

beforeEach(() => {
  occurrences.rows.splice(0, occurrences.rows.length);
  jest.clearAllMocks();
});

describe("the predicates", () => {
  it("keeps the report window inside the consultation earnings hold", () => {
    expect(OUTCOME_REPORT_WINDOW_HOURS).toBe(48);
    expect(OUTCOME_REPORT_WINDOW_HOURS).toBeLessThanOrEqual(
      PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION,
    );
  });

  it("an unconfirmed learner absence holds a consultation's earning, not a subscription's", () => {
    const open = verdict("a");
    expect(matchesWhere(open, UNCONFIRMED_LEARNER_ABSENT)).toBe(true);
    expect(
      matchesWhere(
        { ...open, outcomeConfirmedAt: NOW },
        UNCONFIRMED_LEARNER_ABSENT,
      ),
    ).toBe(false);
    expect(
      matchesWhere(
        { ...open, appointment: { subscriptionId: "sub-1" } },
        UNCONFIRMED_LEARNER_ABSENT,
      ),
    ).toBe(false);
  });

  it("lists an applied negative verdict for ops once its window closes unconfirmed", () => {
    const closed = verdict("a");
    expect(matchesWhere(closed, needsHumanWhere(NOW))).toBe(true);
    const inWindow = verdict("b", { outcomeAt: hoursAgo(47) });
    expect(matchesWhere(inWindow, needsHumanWhere(NOW))).toBe(false);
    const confirmed = verdict("c", { outcomeConfirmedAt: hoursAgo(1) });
    expect(matchesWhere(confirmed, needsHumanWhere(NOW))).toBe(false);
    const held = verdict("d", { outcome: "HELD" });
    expect(matchesWhere(held, unconfirmedClosedVerdictWhere(NOW))).toBe(false);
  });
});

describe("the window-close pass", () => {
  it("confirms a strong closed verdict, leaves a weak or open one, and reports the weak count", async () => {
    occurrences.rows.push(
      verdict("strong"),
      verdict("weak", {}, { attendanceCorroboratedSessionIds: ["s-2"] }),
      verdict("unsettled", {}, { attendanceSettledAt: null }),
      verdict("open", { outcomeAt: hoursAgo(47) }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toEqual({
      confirmed: 1,
      weak: 2,
      errors: [],
      checkpoint: null,
    });
    expect(row("strong").outcomeConfirmedAt).toEqual(NOW);
    expect(row("strong").outcomeAt).toEqual(hoursAgo(50));
    for (const id of ["weak", "unsettled", "open"]) {
      expect(row(id).outcomeConfirmedAt).toBeNull();
    }
  });

  it("loses the CAS to a relabel that lands between its read and its write", async () => {
    occurrences.rows.push(verdict("strong"));
    const read = occurrences.findMany.getMockImplementation()!;
    occurrences.findMany.mockImplementationOnce(async (args) => {
      const rows = await read(args);
      Object.assign(row("strong"), { outcome: "HELD", outcomeAt: NOW });
      return rows;
    });
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.confirmed).toBe(0);
    expect(row("strong").outcomeConfirmedAt).toBeNull();
  });

  it("confirms nothing when an outage read fills its cap, since an overlapping window may be missing", async () => {
    const incidents = prisma.platformIncident as unknown as Table;
    occurrences.rows.push(verdict("strong"));
    for (let i = 0; i < OUTAGE_READ_CAP; i++) {
      incidents.rows.push({
        id: `pi-${i}`,
        startsAt: hoursAgo(10),
        endsAt: hoursAgo(9),
      });
    }
    try {
      const run = await confirmClosedOutcomes(NOW, () => false);
      expect(run.confirmed).toBe(0);
      expect(run.errors).toHaveLength(1);
      expect(row("strong").outcomeConfirmedAt).toBeNull();
    } finally {
      incidents.rows.splice(0, incidents.rows.length);
    }
  });

  it("resumes from the stored cursor, so runs that each read one page reach an older strong verdict and then wrap", async () => {
    for (let i = 0; i < 250; i++) {
      occurrences.rows.push(
        verdict(
          `weak-${String(i).padStart(3, "0")}`,
          // Distinct times: the in-memory table compares dates by identity, not value.
          { outcomeAt: new Date(hoursAgo(49).getTime() - i * 1000) },
          { attendanceCorroboratedSessionIds: ["s-2"] },
        ),
      );
    }
    occurrences.rows.push(verdict("old-strong", { outcomeAt: hoursAgo(52) }));
    // The in-memory table ignores order and take; page it the way Postgres does.
    const read = occurrences.findMany.getMockImplementation()!;
    occurrences.findMany.mockImplementation(async (args) => {
      const rows = (await read(args)) as Row[];
      const ordered = [...rows].sort(
        (a, b) =>
          (b.outcomeAt as Date).getTime() - (a.outcomeAt as Date).getTime() ||
          String(a.id).localeCompare(String(b.id), "en"),
      );
      return ordered.slice(0, (args as unknown as { take: number }).take);
    });
    const onePage = () => {
      let checks = 0;
      return () => checks++ > 0;
    };
    let stored: string | null = null;
    jest.mocked(readJobCheckpoint).mockImplementation(async () => stored);
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const run = await confirmClosedOutcomes(NOW, onePage());
      stored = run.checkpoint;
      runs.push(run);
    }
    expect(runs.map((r) => r.confirmed)).toEqual([0, 0, 1, 0]);
    expect(row("old-strong").outcomeConfirmedAt).toEqual(NOW);
    // The third run reached the end, so the fourth starts again from the newest.
    expect(runs[2].checkpoint).toBeNull();
    expect(runs[3].checkpoint).not.toBeNull();
  });

  it("starts nothing past its deadline", async () => {
    occurrences.rows.push(verdict("strong"));
    const run = await confirmClosedOutcomes(NOW, () => true);
    expect(run.confirmed).toBe(0);
    expect(occurrences.findMany).not.toHaveBeenCalled();
  });
});

describe("the ops confirm door", () => {
  it("stamps only outcomeConfirmedAt, by CAS on the outcome the operator saw", async () => {
    occurrences.rows.push(verdict("a", { outcomeAt: hoursAgo(10) }));
    await confirmSessionOutcome(tx, {
      occurrenceId: "a",
      outcome: "LEARNER_ABSENT",
      now: NOW,
    });
    expect(row("a")).toMatchObject({
      outcome: "LEARNER_ABSENT",
      outcomeAt: hoursAgo(10),
      outcomeConfirmedAt: NOW,
    });
    // A second confirm, or one naming an outcome the row no longer has, is refused.
    await expect(
      confirmSessionOutcome(tx, {
        occurrenceId: "a",
        outcome: "LEARNER_ABSENT",
      }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED" });
  });

  it("refuses a verdict that changed since the operator read it", async () => {
    occurrences.rows.push(verdict("a", { outcome: "HELD" }));
    await expect(
      confirmSessionOutcome(tx, {
        occurrenceId: "a",
        outcome: "LEARNER_ABSENT",
      }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED", httpStatus: 409 });
    expect(row("a").outcomeConfirmedAt).toBeNull();
  });

  it("refuses a parked UNVERIFIED verdict, which ops decide through set-outcome", async () => {
    occurrences.rows.push(
      verdict("a", { completionStatus: "UNVERIFIED", outcome: "HOST_ABSENT" }),
    );
    await expect(
      confirmSessionOutcome(tx, { occurrenceId: "a", outcome: "HOST_ABSENT" }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED" });
    expect(row("a").outcomeConfirmedAt).toBeNull();
  });

  it("answers 404 for a session that does not exist", async () => {
    await expect(
      confirmSessionOutcome(tx, {
        occurrenceId: "missing",
        outcome: "LEARNER_ABSENT",
      }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", httpStatus: 404 });
  });

  it("refuses to confirm an outcome that is not negative, writing nothing", async () => {
    occurrences.rows.push(verdict("a", { outcome: "HELD" }));
    await expect(
      confirmSessionOutcome(tx, { occurrenceId: "a", outcome: "HELD" }),
    ).rejects.toMatchObject({ code: "OUTCOME_NOT_CONFIRMABLE" });
    expect(occurrences.updateMany).not.toHaveBeenCalled();
  });
});

describe("set-outcome", () => {
  const tx = prisma as unknown as Tx;
  const overturnRow = (overrides: Row) =>
    verdict("a", {
      ordinal: 1,
      seatsSettledAt: null,
      appointment: { classId: null, subscription: null },
      ...overrides,
    });

  it("confirms a negative outcome ops write, on a relabel and on a status move", async () => {
    occurrences.rows.push(overturnRow({ outcome: "HELD" }));
    await setSessionOutcome(tx, {
      occurrenceId: "a",
      outcome: "LEARNER_ABSENT",
      actorUserId: "ops-1",
      now: NOW,
    });
    expect(row("a")).toMatchObject({
      completionStatus: "COMPLETED",
      outcomeConfirmedAt: NOW,
    });

    occurrences.rows.splice(0, 1, overturnRow({ outcome: "HELD" }));
    await setSessionOutcome(tx, {
      occurrenceId: "a",
      outcome: "HOST_ABSENT",
      actorUserId: "ops-1",
      now: NOW,
    });
    expect(row("a")).toMatchObject({
      completionStatus: "VOIDED",
      outcomeConfirmedAt: NOW,
    });
  });

  it("clears the stamp when ops overturn a confirmed negative verdict to a positive one", async () => {
    occurrences.rows.push(
      overturnRow({
        completionStatus: "VOIDED",
        outcome: "HOST_ABSENT",
        outcomeConfirmedAt: hoursAgo(5),
      }),
    );
    await setSessionOutcome(tx, {
      occurrenceId: "a",
      outcome: "HELD",
      actorUserId: "ops-1",
      now: NOW,
    });
    expect(row("a")).toMatchObject({
      completionStatus: "COMPLETED",
      outcome: "HELD",
      outcomeConfirmedAt: null,
    });
  });
});
