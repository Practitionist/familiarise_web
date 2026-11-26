/**
 * @jest-environment node
 */

// Invariant: a negative verdict is confirmed once, by CAS from null: by the
// window-close pass on strong evidence after 48 hours, by the ops confirm door
// (which leaves outcomeAt alone), or as ops write it. A weak one stays
// unconfirmed on the needs-human list.

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  const client: Record<string, unknown> = {
    appointmentOccurrence: memTable([], "occ"),
    maintenanceWindow: memTable([], "mw"),
    platformIncident: memTable([], "pi"),
    refund: memTable([], "rf"),
    bookingStatusHistory: memTable([], "h"),
    systemEvent: memTable([], "se"),
  };
  client.$transaction = (fn: (tx: unknown) => unknown) => fn(client);
  return { __esModule: true, default: client };
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
  // No make-up was offered for these sessions.
  cancelUnstartedMakeUp: jest.fn(async () => ({ cancelled: false, bells: [] })),
  onClassVoidConfirmed: jest.fn(async () => ({
    bells: [],
    cancelEmailArgs: null,
    exitEmailArgs: null,
  })),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/consultant-no-show", () => ({
  confirmConsultantNoShow: jest.fn(async () => ({
    kind: "claimed",
    refunded: true,
    held: null,
  })),
  readNoShowClaim: jest.fn(async () => ({ consultationId: "cons-a" })),
  readOperatorNoShowClaim: jest.fn(async () => ({
    claim: { consultationId: "cons-a" },
  })),
  // No payment on record unless a case says so.
  readSessionNoShow: jest.fn(async () => null),
  oweSessionNoShowRefundTx: jest.fn(async () => ({ held: null })),
  settleSessionNoShowRefund: jest.fn(async () => ({ refunded: true })),
  claimNoShowTx: jest.fn(async () => ({ held: null })),
  settleClaimedNoShow: jest.fn(async () => ({ refunded: true })),
}));

import prisma, { type Tx } from "@/lib/prisma";
import { matchesWhere, type memTable, type Row } from "../fixtures/mem-db";
import {
  makeUpWindowStart,
  needsHumanWhere,
  UNSETTLED_MISS,
  OUTCOME_REPORT_WINDOW_HOURS,
  UNCONFIRMED_LEARNER_ABSENT,
  unconfirmedClosedVerdictWhere,
  voidWindowStartedBefore,
} from "@/lib/booking/misses";
import { confirmClosedOutcomes } from "@/lib/booking/session-outcome-sweep";
import {
  confirmSessionOutcome,
  setSessionOutcome,
} from "@/lib/backoffice/session-outcomes";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import { readJobCheckpoint } from "@/lib/cron/with-cron-lock";
import { onClassVoidConfirmed } from "@/lib/booking/class-sessions";
import {
  claimNoShowTx,
  confirmConsultantNoShow,
  oweSessionNoShowRefundTx,
  readNoShowClaim,
  readOperatorNoShowClaim,
  readSessionNoShow,
  settleClaimedNoShow,
  settleSessionNoShowRefund,
} from "@/lib/booking/consultant-no-show";

type Table = ReturnType<typeof memTable>;
const occurrences = prisma.appointmentOccurrence as unknown as Table;
const { systemEvent: strikes, platformIncident: incidents } =
  prisma as unknown as Record<string, Table>;

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
    supportCases: [],
    appointment: {
      subscriptionId: null,
      participants: [{ userId: "priya" }],
      organizationId: null,
      consultation: {
        consultationPlan: {
          consultantProfileId: "cp-hannah",
          consultantProfile: { userId: "hannah" },
        },
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
  for (const table of [occurrences, strikes, incidents]) {
    table.rows.splice(0, table.rows.length);
  }
  jest.clearAllMocks();
  jest.mocked(readJobCheckpoint).mockImplementation(async () => null);
});

describe("the predicates", () => {
  it("keeps the report window inside the consultation earnings hold", () => {
    expect(OUTCOME_REPORT_WINDOW_HOURS).toBe(48);
    expect(OUTCOME_REPORT_WINDOW_HOURS).toBeLessThanOrEqual(
      PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION,
    );
  });

  it("an unconfirmed learner absence holds its booking's earnings, a subscription's included", () => {
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
    ).toBe(true);
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
      claimed: 0,
      declined: 0,
      weak: 2,
      disputed: 0,
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

  it("loses the CAS to a dispute filed between its read and its write", async () => {
    occurrences.rows.push(verdict("strong"));
    const read = occurrences.findMany.getMockImplementation()!;
    occurrences.findMany.mockImplementationOnce(async (args) => {
      const rows = (await read(args)) as Row[];
      // A fresh array, so the page the pass judges still shows no report.
      const pageRows = rows.map((r) => ({ ...r, supportCases: [] }));
      row("strong").supportCases = [filed("attendee_attended", "priya")];
      return pageRows;
    });
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.confirmed).toBe(0);
    expect(row("strong").outcomeConfirmedAt).toBeNull();
  });

  it("holds each row only on a dispute inside its own window, even when the rows are stamped together", async () => {
    // A's window closed 12 hours ago, B's 2 hours ago.
    occurrences.rows.push(
      verdict("a", { outcomeAt: hoursAgo(60) }),
      verdict("b", { outcomeAt: hoursAgo(50) }),
    );
    const read = occurrences.findMany.getMockImplementation()!;
    occurrences.findMany.mockImplementationOnce(async (args) => {
      const rows = (await read(args)) as Row[];
      const pageRows = rows.map((r) => ({ ...r, supportCases: [] }));
      // Both answered 5 hours ago, after the read: late for A, inside B's window.
      for (const id of ["a", "b"]) {
        row(id).supportCases = [
          { ...filed("attendee_attended", "priya"), flowReasonAt: hoursAgo(5) },
        ];
      }
      return pageRows;
    });
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.confirmed).toBe(1);
    expect(row("a").outcomeConfirmedAt).toEqual(NOW);
    expect(row("b").outcomeConfirmedAt).toBeNull();
  });

  it("sees an incident over a booking however many older incidents the history holds, and confirms the booking none overlaps", async () => {
    const incidents = prisma.platformIncident as unknown as Table;
    const DAY = 24 * 60;
    // "clear" was booked ten days before "hit"; neither overlaps the 250 incidents between them.
    const shifted = (minutes: number) => at(minutes - 10 * DAY);
    occurrences.rows.push(
      verdict(
        "clear",
        { startsAt: shifted(0), endsAt: shifted(60) },
        {
          endedAt: shifted(62),
          presences: [
            { userId: "hannah", joinedAt: shifted(0), leftAt: shifted(60) },
          ],
        },
      ),
      verdict("hit"),
    );
    for (let i = 0; i < 250; i++) {
      incidents.rows.push({
        id: `pi-${String(i).padStart(3, "0")}`,
        startsAt: at(-9 * DAY + i * 10),
        endsAt: at(-9 * DAY + i * 10 + 1),
      });
    }
    // The 251st by start time is the one over "hit".
    incidents.rows.push({ id: "pi-hit", startsAt: at(10), endsAt: at(20) });
    // Postgres honours order and take; the in-memory table does not, so page it the same way.
    const read = incidents.findMany.getMockImplementation()!;
    incidents.findMany.mockImplementation(async (args) => {
      const rows = (await read(args)) as Row[];
      const ordered = [...rows].sort(
        (a, b) =>
          (a.startsAt as Date).getTime() - (b.startsAt as Date).getTime(),
      );
      const take = (args as unknown as { take?: number }).take;
      return take ? ordered.slice(0, take) : ordered;
    });
    try {
      const run = await confirmClosedOutcomes(NOW, () => false);
      expect(run).toMatchObject({ confirmed: 1, weak: 1, errors: [] });
      expect(row("clear").outcomeConfirmedAt).toEqual(NOW);
      expect(row("hit").outcomeConfirmedAt).toBeNull();
    } finally {
      incidents.rows.splice(0, incidents.rows.length);
      incidents.findMany.mockImplementation(read);
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
    // One check before the cursor lookup and one before the first page; the next stops the run.
    const onePage = () => {
      let checks = 0;
      return () => checks++ > 1;
    };
    let stored: string | null = null;
    jest.mocked(readJobCheckpoint).mockImplementation(async () => stored);
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const run = await confirmClosedOutcomes(NOW, onePage());
      if (run.checkpoint !== undefined) stored = run.checkpoint;
      runs.push(run);
    }
    expect(runs.map((r) => r.confirmed)).toEqual([0, 0, 1, 0]);
    expect(row("old-strong").outcomeConfirmedAt).toEqual(NOW);
    // The third run reached the end, so the fourth starts again from the newest.
    expect(runs[2].checkpoint).toBeNull();
    expect(runs[3].checkpoint).not.toBeNull();
  });

  it("starts nothing past its deadline, not even the cursor lookup, and leaves the stored cursor standing", async () => {
    occurrences.rows.push(verdict("strong"));
    const run = await confirmClosedOutcomes(NOW, () => true);
    expect(run.confirmed).toBe(0);
    expect(readJobCheckpoint).not.toHaveBeenCalled();
    expect(occurrences.findMany).not.toHaveBeenCalled();
    expect(run).not.toHaveProperty("checkpoint");
  });

  it("reads nothing when the cursor lookup fails, and leaves the stored cursor standing", async () => {
    occurrences.rows.push(verdict("strong"));
    jest
      .mocked(readJobCheckpoint)
      .mockRejectedValueOnce(new Error("trail unavailable"));
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.errors).toHaveLength(1);
    expect(occurrences.findMany).not.toHaveBeenCalled();
    expect(run).not.toHaveProperty("checkpoint");
  });
});

/** A linked case in the shape the pass's select returns. */
const filed = (flowReason: string, requesterUserId: string): Row => ({
  id: `case-${flowReason}`,
  flowReason,
  requesterUserId,
  ownershipScope: "PERSONAL",
  flowReasonAt: hoursAgo(49),
  deletedAt: null,
});

/** Priya waited the hour and Hannah never came: a strong host absence. */
const hostAbsent = (id: string, overrides: Row = {}, meeting: Row = {}) =>
  verdict(
    id,
    { completionStatus: "VOIDED", outcome: "HOST_ABSENT", ...overrides },
    {
      presences: [{ userId: "priya", joinedAt: at(0), leftAt: at(60) }],
      ...meeting,
    },
  );

describe("participant reports", () => {
  it("does not stamp a closed, strong verdict the accused party disputed, and lists it for ops", async () => {
    occurrences.rows.push(
      verdict("a", { supportCases: [filed("attendee_attended", "priya")] }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ confirmed: 0, weak: 0, disputed: 1 });
    expect(row("a").outcomeConfirmedAt).toBeNull();
    expect(matchesWhere(row("a"), needsHumanWhere(NOW))).toBe(true);
  });

  it("stamps a strong verdict at once when the harmed party agrees inside the window", async () => {
    occurrences.rows.push(
      hostAbsent("a", {
        outcomeAt: hoursAgo(10),
        supportCases: [
          { ...filed("provider_no_show", "priya"), flowReasonAt: hoursAgo(9) },
        ],
      }),
    );
    // In the window it is on the list until the pass applies it.
    expect(matchesWhere(row("a"), needsHumanWhere(NOW))).toBe(true);
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.confirmed).toBe(1);
    expect(row("a").outcomeConfirmedAt).toEqual(NOW);
    expect(matchesWhere(row("a"), needsHumanWhere(NOW))).toBe(false);
  });

  it("judges a report by when its reason was answered, not when its case was opened", async () => {
    occurrences.rows.push(
      // Opened inside the window, answered an hour after it closed: no effect.
      verdict("late", {
        supportCases: [
          {
            ...filed("attendee_attended", "priya"),
            createdAt: hoursAgo(49),
            flowReasonAt: hoursAgo(1),
          },
        ],
      }),
      // Answered before the session ended: no effect.
      verdict("beforeEnd", {
        supportCases: [
          {
            ...filed("attendee_attended", "priya"),
            createdAt: at(-10),
            flowReasonAt: at(-5),
          },
        ],
      }),
      // Opened before the session ended, answered after it: a dispute.
      verdict("early", {
        supportCases: [
          {
            ...filed("attendee_attended", "priya"),
            createdAt: at(-10),
            flowReasonAt: hoursAgo(49),
          },
        ],
      }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ confirmed: 2, disputed: 1 });
    expect(row("late").outcomeConfirmedAt).toEqual(NOW);
    expect(row("beforeEnd").outcomeConfirmedAt).toEqual(NOW);
    expect(row("early").outcomeConfirmedAt).toBeNull();
  });

  it("stamps past a dispute reason on an org operator's case, which counts for nothing", async () => {
    occurrences.rows.push(
      verdict("a", {
        supportCases: [
          {
            ...filed("attendee_attended", "priya"),
            ownershipScope: "ORG_OPERATIONS",
          },
        ],
      }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.confirmed).toBe(1);
    expect(row("a").outcomeConfirmedAt).toEqual(NOW);
  });

  it("does not stamp an open window on an agreement the wrong side filed", async () => {
    occurrences.rows.push(
      hostAbsent("a", {
        outcomeAt: hoursAgo(10),
        supportCases: [
          { ...filed("provider_no_show", "hannah"), flowReasonAt: hoursAgo(9) },
        ],
      }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ confirmed: 0, weak: 0, disputed: 0 });
    expect(row("a").outcomeConfirmedAt).toBeNull();
  });

  it("does not stamp a weak verdict the harmed party agrees with", async () => {
    occurrences.rows.push(
      hostAbsent(
        "a",
        {
          outcomeAt: hoursAgo(10),
          supportCases: [
            {
              ...filed("provider_no_show", "priya"),
              flowReasonAt: hoursAgo(9),
            },
          ],
        },
        { attendanceCorroboratedSessionIds: ["s-2"] },
      ),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ confirmed: 0, weak: 1 });
    expect(row("a").outcomeConfirmedAt).toBeNull();
  });

  it("changes nothing on a neutral report, closed or open", async () => {
    occurrences.rows.push(
      verdict("closed", {
        supportCases: [filed("attendee_no_show", "hannah")],
      }),
      verdict("open", {
        outcomeAt: hoursAgo(10),
        supportCases: [filed("attendee_no_show", "hannah")],
      }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ confirmed: 1, weak: 0, disputed: 0 });
    expect(row("closed").outcomeConfirmedAt).toEqual(NOW);
    expect(row("open").outcomeConfirmedAt).toBeNull();
    expect(matchesWhere(row("open"), needsHumanWhere(NOW))).toBe(false);
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

  it("refuses a parked UNVERIFIED verdict other than a consultation's no-show, which ops decide through set-outcome", async () => {
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

/** A consultation's proposed host no-show: Hannah never joined, Priya waited the hour. */
function proposal(id: string, overrides: Row = {}): Row {
  return verdict(
    id,
    {
      completionStatus: "UNVERIFIED",
      outcome: "HOST_ABSENT",
      appointment: {
        ...(verdict(id).appointment as Row),
        consultationId: `cons-${id}`,
      },
      ...overrides,
    },
    { presences: [{ userId: "priya", joinedAt: at(0), leftAt: at(60) }] },
  );
}

describe("a proposed consultant no-show", () => {
  it("is claimed at the window close on strong, silent evidence, with the pass's own guard", async () => {
    occurrences.rows.push(proposal("a"));
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ confirmed: 1, claimed: 1, weak: 0 });
    expect(confirmConsultantNoShow).toHaveBeenCalledTimes(1);
    const [id, opts] = jest.mocked(confirmConsultantNoShow).mock.calls[0];
    expect(id).toBe("a");
    // The claim's CAS re-checks the candidate, the outcome and the dispute window, like a bare stamp.
    expect(matchesWhere(row("a"), opts.guard)).toBe(true);
    row("a").supportCases = [filed("provider_attended", "hannah")];
    expect(matchesWhere(row("a"), opts.guard)).toBe(false);
    // The pass never stamps a proposal itself: the claim does, in its transaction.
    expect(row("a").outcomeConfirmedAt).toBeNull();
  });

  it("is claimed early when the learner agrees, and not while the window is open and silent", async () => {
    occurrences.rows.push(
      proposal("agreed", {
        outcomeAt: hoursAgo(5),
        supportCases: [filed("provider_no_show", "priya")],
      }),
      proposal("open", { outcomeAt: hoursAgo(5) }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.claimed).toBe(1);
    expect(
      jest.mocked(confirmConsultantNoShow).mock.calls.map((c) => c[0]),
    ).toEqual(["agreed"]);
  });

  it("is never claimed when the consultant disputes it, or on weak evidence", async () => {
    occurrences.rows.push(
      proposal("disputed", {
        supportCases: [filed("provider_attended", "hannah")],
      }),
      proposal("weak", {
        meeting: {
          ...(proposal("weak").meeting as Row),
          attendanceCorroboratedSessionIds: ["s-2"],
        },
      }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run).toMatchObject({ claimed: 0, disputed: 1, weak: 1 });
    expect(confirmConsultantNoShow).not.toHaveBeenCalled();
  });

  it("counts a declined claim for ops, and keeps the cursor before a page whose claims the deadline cut", async () => {
    occurrences.rows.push(proposal("a"));
    jest
      .mocked(confirmConsultantNoShow)
      .mockResolvedValueOnce({ kind: "declined" });
    expect(await confirmClosedOutcomes(NOW, () => false)).toMatchObject({
      claimed: 0,
      declined: 1,
    });
    // Two checks before the page is read; the third, before the claim, is past the deadline.
    let checks = 0;
    const run = await confirmClosedOutcomes(NOW, () => checks++ > 1);
    expect(run.claimed).toBe(0);
    expect(run.checkpoint).toBeNull();
  });

  it("ops Confirm runs the claim in the door's transaction and drives the refund after the commit", async () => {
    occurrences.rows.push(proposal("a"));
    const result = await confirmSessionOutcome(tx, {
      occurrenceId: "a",
      outcome: "HOST_ABSENT",
      actorUserId: "ops-1",
      now: NOW,
    });
    expect(readNoShowClaim).toHaveBeenCalledWith(tx, "a");
    expect(claimNoShowTx).toHaveBeenCalledWith(
      tx,
      { consultationId: "cons-a" },
      { now: NOW, actorUserId: "ops-1" },
    );
    expect(settleClaimedNoShow).not.toHaveBeenCalled();
    await result.afterCommit?.();
    expect(settleClaimedNoShow).toHaveBeenCalledTimes(1);
  });

  it("ops Confirm refuses a proposal whose booking no longer qualifies, claiming nothing", async () => {
    occurrences.rows.push(proposal("a"));
    jest.mocked(readNoShowClaim).mockResolvedValueOnce(null);
    await expect(
      confirmSessionOutcome(tx, { occurrenceId: "a", outcome: "HOST_ABSENT" }),
    ).rejects.toMatchObject({ code: "NO_SHOW_NOT_CLAIMABLE" });
    expect(claimNoShowTx).not.toHaveBeenCalled();
  });
});

describe("a host-attributed class void", () => {
  const classVoid = (id: string, overrides: Row = {}) =>
    hostAbsent(id, {
      appointmentId: `apt-${id}`,
      appointment: {
        ...(verdict(id).appointment as Row),
        consultation: null,
        class: {
          classPlan: {
            consultantProfile: { userId: "hannah" },
            collaborators: [],
          },
        },
        classId: `cls-${id}`,
      },
      ...overrides,
    });

  it("counts toward the series only when the pass stamps it, in the stamp's transaction", async () => {
    occurrences.rows.push(
      classVoid("closed"),
      classVoid("open", { outcomeAt: hoursAgo(5) }),
    );
    const run = await confirmClosedOutcomes(NOW, () => false);
    expect(run.confirmed).toBe(1);
    expect(row("closed").outcomeConfirmedAt).toEqual(NOW);
    expect(onClassVoidConfirmed).toHaveBeenCalledTimes(1);
    expect(onClassVoidConfirmed).toHaveBeenCalledWith(prisma, {
      appointmentId: "apt-closed",
      occurrenceId: "closed",
      confirmedAt: NOW,
    });
  });

  it("confirms none once the pass is past its deadline, and keeps the cursor before the page", async () => {
    occurrences.rows.push(classVoid("closed"));
    // Two checks before the page is read; the third, before the class void, is past the deadline.
    let checks = 0;
    const run = await confirmClosedOutcomes(NOW, () => checks++ > 1);
    expect(run.confirmed).toBe(0);
    expect(onClassVoidConfirmed).not.toHaveBeenCalled();
    expect(row("closed").outcomeConfirmedAt).toBeNull();
    expect(run.checkpoint).toBeNull();
  });
});

describe("ops set-outcome", () => {
  it("refuses a relabel when a confirmation was stamped between its read and its write", async () => {
    occurrences.rows.push(
      verdict("a", { completionStatus: "VOIDED", outcome: "HOST_ABSENT" }),
    );
    const read = occurrences.findUnique.getMockImplementation()!;
    occurrences.findUnique.mockImplementationOnce(async (args) => {
      const stale = await read(args);
      // The window-close pass stamps the void after the door read it.
      row("a").outcomeConfirmedAt = NOW;
      return stale;
    });
    await expect(
      setSessionOutcome(tx, {
        occurrenceId: "a",
        outcome: "CUT_SHORT",
        actorUserId: "ops-1",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED" });
    expect(row("a").outcome).toBe("HOST_ABSENT");
  });

  const relabelVoid = async (
    from: Row,
    outcome: "PLATFORM_OUTAGE" | "CUT_SHORT",
  ) => {
    occurrences.rows.push(
      verdict("a", { completionStatus: "VOIDED", ordinal: 1, ...from }),
    );
    await setSessionOutcome(tx, {
      occurrenceId: "a",
      outcome,
      actorUserId: "ops-1",
      now: NOW,
    });
    return row("a");
  };

  it("relabelling a void that waited for its confirmation to an outage starts its 14 days at the relabel", async () => {
    // Voided 4 days ago as expert absent, never confirmed.
    const relabelled = await relabelVoid(
      {
        outcome: "HOST_ABSENT",
        voidedAt: hoursAgo(96),
        outcomeAt: hoursAgo(96),
      },
      "PLATFORM_OUTAGE",
    );
    expect(relabelled).toMatchObject({
      outcome: "PLATFORM_OUTAGE",
      outcomeConfirmedAt: null,
      voidedAt: NOW,
    });
    expect(makeUpWindowStart(relabelled)).toEqual(NOW);
    // The settle sweep's own test of the window agrees: not over until 14 days after the relabel.
    expect(matchesWhere(relabelled, voidWindowStartedBefore(NOW))).toBe(false);
    expect(
      matchesWhere(relabelled, voidWindowStartedBefore(hoursAgo(-1))),
    ).toBe(true);
  });

  it.each([
    [
      "a confirmed void relabelled to an outage",
      {
        outcome: "HOST_ABSENT",
        voidedAt: hoursAgo(96),
        outcomeConfirmedAt: hoursAgo(48),
      },
      "PLATFORM_OUTAGE",
      hoursAgo(48),
    ],
    [
      "a confirmed void relabelled to another host-attributed outcome",
      {
        outcome: "HOST_ABSENT",
        voidedAt: hoursAgo(96),
        outcomeConfirmedAt: hoursAgo(48),
      },
      "CUT_SHORT",
      hoursAgo(48),
    ],
    [
      "an outage void, which never waited, relabelled to a host-attributed outcome",
      { outcome: "PLATFORM_OUTAGE", voidedAt: hoursAgo(96) },
      "CUT_SHORT",
      hoursAgo(96),
    ],
  ] as const)(
    "%s keeps its make-up window",
    async (_label, from, to, start) => {
      const relabelled = await relabelVoid(from, to);
      expect(relabelled.outcome).toBe(to);
      expect(makeUpWindowStart(relabelled)).toEqual(start);
    },
  );

  it("refuses a relabel when another relabel changed the outcome between its read and its write, whatever the stamp", async () => {
    occurrences.rows.push(
      verdict("a", {
        completionStatus: "VOIDED",
        ordinal: 1,
        outcome: "HOST_ABSENT",
        voidedAt: hoursAgo(96),
      }),
    );
    const read = occurrences.findUnique.getMockImplementation()!;
    occurrences.findUnique.mockImplementationOnce(async (args) => {
      const stale = await read(args);
      // Another operator relabels it to an outage, which leaves the stamp null.
      row("a").outcome = "PLATFORM_OUTAGE";
      return stale;
    });
    await expect(
      setSessionOutcome(tx, {
        occurrenceId: "a",
        outcome: "CUT_SHORT",
        actorUserId: "ops-1",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED" });
    expect(row("a").outcome).toBe("PLATFORM_OUTAGE");
  });

  const expertAbsent = (occurrenceId = "a") =>
    setSessionOutcome(tx, {
      occurrenceId,
      outcome: "HOST_ABSENT",
      actorUserId: "ops-1",
      now: NOW,
    });

  it("expert absent on a consultation runs the no-show claim in the door's transaction, whatever parked the session, and never voids it", async () => {
    // The pass declined this proposal, the sweep parked this one inconclusive, and this one was written held.
    for (const parked of [
      proposal("a"),
      proposal("a", { outcome: "INCONCLUSIVE" }),
      proposal("a", { completionStatus: "COMPLETED", outcome: "HELD" }),
    ]) {
      occurrences.rows.splice(0, occurrences.rows.length, parked);
      jest.clearAllMocks();

      const result = await expertAbsent();

      expect(readOperatorNoShowClaim).toHaveBeenCalledWith(tx, "a");
      expect(claimNoShowTx).toHaveBeenCalledWith(
        tx,
        { consultationId: "cons-a" },
        { now: NOW, actorUserId: "ops-1" },
      );
      // The session is the standing proposal the claim's compare-and-set cancels.
      expect(row("a")).toMatchObject({
        completionStatus: "UNVERIFIED",
        outcome: "HOST_ABSENT",
        outcomeConfirmedAt: null,
      });
      expect(result.after).toEqual({
        completionStatus: "CANCELLED",
        outcome: "HOST_ABSENT",
      });
      // The refund is driven only after the door's transaction commits.
      expect(settleClaimedNoShow).not.toHaveBeenCalled();
      await result.afterCommit?.();
      expect(settleClaimedNoShow).toHaveBeenCalledTimes(1);
    }
  });

  const parked = (overrides: Row = {}) =>
    proposal("a", {
      outcome: "INCONCLUSIVE",
      ordinal: 1,
      seatsSettledAt: null,
      ...overrides,
    });

  const REFUND = {
    consultationId: "cons-a",
    occurrenceId: "a",
    payment: { id: "pay-a", currency: "INR" },
  };
  const paidSingleSession = (status: "COMPLETED" | "APPROVED" | "CANCELLED") =>
    jest.mocked(readSessionNoShow).mockResolvedValueOnce({
      status,
      otherSessions: 0,
      refund: REFUND,
    } as never);

  it.each([
    [
      "a completed, paid, single-session consultation",
      parked({ completionStatus: "COMPLETED", outcome: "HELD" }),
      {
        reason: "NOT_APPROVED",
        status: "COMPLETED",
        paid: true,
        otherSessions: 0,
      },
      "COMPLETED",
    ],
    [
      "a consultation session already voided as cut short",
      parked({
        completionStatus: "VOIDED",
        outcome: "CUT_SHORT",
        voidedAt: hoursAgo(50),
        outcomeConfirmedAt: hoursAgo(2),
      }),
      null,
      "APPROVED",
    ],
  ] as const)(
    "expert absent on %s owes the full refund in the door's transaction, settles the session so the day-14 sweep never refunds it, and drives the refund after the commit",
    async (_label, session, bar, status) => {
      occurrences.rows.push(session);
      if (bar) {
        jest.mocked(readOperatorNoShowClaim).mockResolvedValueOnce({ bar });
      }
      paidSingleSession(status);

      const result = await expertAbsent();

      expect(row("a")).toMatchObject({
        completionStatus: "VOIDED",
        outcome: "HOST_ABSENT",
        // Settled with the owed refund: the sweep's cohort and the earnings-holding miss both need this null.
        seatsSettledAt: NOW,
      });
      expect(matchesWhere(row("a"), UNSETTLED_MISS)).toBe(false);
      expect(oweSessionNoShowRefundTx).toHaveBeenCalledWith(tx, REFUND);
      expect(strikes.rows).toHaveLength(1);
      // The booking is not cancelled: the whole-booking claim did not run.
      expect(claimNoShowTx).not.toHaveBeenCalled();
      expect(settleSessionNoShowRefund).not.toHaveBeenCalled();
      await result.afterCommit?.();
      expect(settleSessionNoShowRefund).toHaveBeenCalledWith(
        REFUND,
        null,
        expect.anything(),
      );
    },
  );

  it("expert absent on a session of a cancelled booking records the strike and owes nothing more: what the cancel paid stands", async () => {
    occurrences.rows.push(parked());
    jest.mocked(readOperatorNoShowClaim).mockResolvedValueOnce({
      bar: {
        reason: "NOT_APPROVED",
        status: "CANCELLED",
        paid: true,
        otherSessions: 0,
      },
    });
    paidSingleSession("CANCELLED");

    const result = await expertAbsent();

    expect(row("a")).toMatchObject({
      completionStatus: "VOIDED",
      seatsSettledAt: null,
    });
    expect(strikes.rows).toHaveLength(1);
    expect(oweSessionNoShowRefundTx).not.toHaveBeenCalled();
    expect(result.afterCommit).toBeUndefined();
  });

  it.each([["an unpaid booking", { reason: "UNPAID" }]] as const)(
    "expert absent on %s voids this one session, confirmed as written, with one strike and no claim",
    async (_label, bar) => {
      occurrences.rows.push(parked());
      jest.mocked(readOperatorNoShowClaim).mockResolvedValueOnce({ bar });

      const result = await expertAbsent();

      // Both stamps at the same instant: the 14-day make-up window starts now.
      expect(row("a")).toMatchObject({
        completionStatus: "VOIDED",
        outcome: "HOST_ABSENT",
        outcomeConfirmedAt: NOW,
        voidedAt: NOW,
      });
      expect(result.after).toEqual({
        completionStatus: "VOIDED",
        outcome: "HOST_ABSENT",
      });
      // No cancel, no owed refund marker and no refund drive: the day-14 sweep owns the money.
      expect(claimNoShowTx).not.toHaveBeenCalled();
      expect(result.afterCommit).toBeUndefined();
      expect(strikes.rows.map((r) => r.context)).toEqual([
        {
          strike: "CONSULTANT_NO_SHOW",
          consultantProfileId: "cp-hannah",
          appointmentId: "apt-a",
          occurrenceIds: ["a"],
        },
      ]);
    },
  );

  it("expert absent on a session already voided relabels it and records the strike once: a repeat click writes no second strike", async () => {
    occurrences.rows.push(
      parked({
        completionStatus: "VOIDED",
        outcome: "CUT_SHORT",
        voidedAt: hoursAgo(50),
      }),
    );

    await expertAbsent();

    expect(row("a")).toMatchObject({
      completionStatus: "VOIDED",
      outcome: "HOST_ABSENT",
      outcomeConfirmedAt: NOW,
    });
    expect(readOperatorNoShowClaim).not.toHaveBeenCalled();
    expect(strikes.rows).toHaveLength(1);

    await expertAbsent();
    expect(strikes.rows).toHaveLength(1);
  });

  it.each([
    // The parked session's booking is unpaid, so the session-level void would otherwise run.
    ["a parked session", {}, true],
    [
      "an already voided session",
      {
        completionStatus: "VOIDED",
        outcome: "PLATFORM_OUTAGE",
        voidedAt: hoursAgo(50),
      },
      false,
    ],
  ] as const)(
    "refuses expert absent on %s inside a declared incident: no void, no relabel, no strike",
    async (_label, session, judged) => {
      occurrences.rows.push(parked(session));
      incidents.rows.push({ id: "pi-1", startsAt: at(30), endsAt: at(90) });
      if (judged) {
        jest
          .mocked(readOperatorNoShowClaim)
          .mockResolvedValueOnce({ bar: { reason: "UNPAID" } });
      }
      const before = { ...row("a") };

      await expect(expertAbsent()).rejects.toMatchObject({
        code: "NO_SHOW_DURING_OUTAGE",
        httpStatus: 409,
      });

      expect(row("a")).toEqual(before);
      expect(strikes.rows).toHaveLength(0);
    },
  );

  const sibling = (over: Row) => ({
    id: "b",
    startsAt: at(-1440),
    endsAt: at(-1380),
    completionStatus: "COMPLETED",
    outcome: "HELD",
    ...over,
  });

  it.each([
    [
      // Parked and undecided: the whole-booking cancel may still apply once it is decided.
      {
        reason: "SIBLING",
        siblings: [
          sibling({ completionStatus: "UNVERIFIED", outcome: "NOBODY_JOINED" }),
        ],
      },
      "NO_SHOW_SIBLING_SESSION",
    ],
    [
      // A held session stands on a paid booking: one session's share has no refund path yet.
      { reason: "SIBLING", siblings: [sibling({})] },
      "NO_SHOW_OTHER_SESSIONS_STAND",
    ],
    [
      {
        reason: "NOT_APPROVED",
        status: "COMPLETED",
        paid: true,
        otherSessions: 1,
      },
      "NO_SHOW_OTHER_SESSIONS_STAND",
    ],
    [{ reason: "BOOKING_MISSING" }, "NO_SHOW_NOT_CLAIMABLE"],
  ] as const)(
    "refuses expert absent by name where neither remedy fits (%j), writing nothing",
    async (bar, code) => {
      occurrences.rows.push(parked());
      jest
        .mocked(readOperatorNoShowClaim)
        .mockResolvedValueOnce({ bar } as never);

      await expect(expertAbsent()).rejects.toMatchObject({
        code,
        httpStatus: 409,
      });

      expect(claimNoShowTx).not.toHaveBeenCalled();
      expect(row("a")).toMatchObject({
        completionStatus: "UNVERIFIED",
        outcome: "INCONCLUSIVE",
      });
      expect(strikes.rows).toHaveLength(0);
    },
  );
});
