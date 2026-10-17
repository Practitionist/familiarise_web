/**
 * @jest-environment node
 */

/**
 * #1320 — availability stored as adjacent one-hour rows must behave exactly
 * like one two-hour row on every surface: the merge-on-save helper, the
 * booking generator, and checkout's coverage rule.
 */

import fs from "fs";
import path from "path";
import {
  coalesceAndResolve,
  mergeAdjacentCustomRows,
  mergeAdjacentWeeklyRows,
} from "../../utils/scheduling-engine/mergeAdjacentWeeklyRows";
import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "../../utils/scheduling-engine/availabilityCoverage";
import type { Tx } from "../../lib/prisma";
import {
  breakDownSlotsPreservingStatus,
  mergeConsecutiveSlots,
} from "../../utils/scheduling-engine/intervals";
import type { TIntervalTiming } from "../../types/slots";
import type { DayOfWeek } from "@prisma/client";
import { weeklyWriterColumnsFromLocal } from "../../utils/schedule/weekly-projection";

/** An IST weekly row described by its local columns, with its UTC writer columns derived. */
const localRow = (
  localStartDay: DayOfWeek,
  localStartMinutes: number,
  localEndMinutes: number,
  localEndDay: DayOfWeek = localStartDay,
) => ({
  ...weeklyWriterColumnsFromLocal(
    { localStartDay, localStartMinutes, localEndMinutes },
    330,
  ),
  utcOffsetMinutes: 330,
  timezone: "Asia/Kolkata",
  localStartDay,
  localStartMinutes,
  localEndMinutes,
  localEndDay,
});

// The live rows from the report: Monday 10:00–11:00 and 11:00–12:00 UTC
// (15:30–17:30 IST), stored as two 60-minute rows.
const ROW_A = localRow("MONDAY", 930, 990);
const ROW_B = localRow("MONDAY", 990, 1050);
const ROW_GAP = localRow("MONDAY", 1170, 1230);

describe("mergeAdjacentWeeklyRows", () => {
  it("folds exactly-adjacent same-day rows into one and leaves gaps alone", () => {
    const merged = mergeAdjacentWeeklyRows([ROW_GAP, ROW_B, ROW_A]);
    expect(merged).toEqual([
      { ...ROW_A, endTimeUtc: 720, localEndMinutes: 1050 },
      ROW_GAP,
    ]);
  });

  it("never merges across days, zones, or overnight rows", () => {
    const tue = localRow("TUESDAY", 990, 1050);
    const otherZone = { ...ROW_B, timezone: "Asia/Dubai" };
    const evening = localRow("MONDAY", 900, 1380);
    const overnight = localRow("MONDAY", 1380, 60, "TUESDAY");
    expect(mergeAdjacentWeeklyRows([ROW_A, tue])).toHaveLength(2);
    expect(mergeAdjacentWeeklyRows([ROW_A, otherZone])).toHaveLength(2);
    expect(mergeAdjacentWeeklyRows([evening, overnight])).toHaveLength(2);
  });

  it("leaves a row without local columns untouched", () => {
    const legacy = { ...ROW_B, timezone: null, localStartMinutes: null };
    expect(mergeAdjacentWeeklyRows([ROW_A, legacy])).toEqual([ROW_A, legacy]);
  });

  it("is idempotent", () => {
    const once = mergeAdjacentWeeklyRows([ROW_A, ROW_B]);
    expect(mergeAdjacentWeeklyRows(once)).toEqual(once);
  });

  // A merged row longer than isValidTimeRange's cap is filtered out of the
  // settings form, and the next PUT deletes what the form did not send back.
  it("stops the fold at the twelve-hour bound", () => {
    const eightHours = localRow("MONDAY", 0, 480);
    const nextEightHours = localRow("MONDAY", 480, 960);
    expect(mergeAdjacentWeeklyRows([eightHours, nextEightHours])).toHaveLength(
      2,
    );

    const fourHours = localRow("MONDAY", 0, 240);
    const thenEightHours = localRow("MONDAY", 240, 720);
    expect(mergeAdjacentWeeklyRows([fourHours, thenEightHours])).toEqual([
      { ...localRow("MONDAY", 0, 720), endTimeUtc: thenEightHours.endTimeUtc },
    ]);
  });

  it("does not fold a Monday night's tail into the same Monday's pre-dawn row", () => {
    // Monday 22:00 -> Tuesday 01:00 and Monday 01:00 -> 02:00 share a UTC
    // minute (19:30Z) but sit a day apart locally.
    const monNightIst = localRow("MONDAY", 1320, 60, "TUESDAY");
    const monPreDawnIst = localRow("MONDAY", 60, 120);
    expect(mergeAdjacentWeeklyRows([monNightIst, monPreDawnIst])).toHaveLength(
      2,
    );
  });
});

describe("mergeAdjacentCustomRows (#1320)", () => {
  const CUSTOM_A = {
    startsAt: new Date(Date.UTC(2026, 8, 7, 10, 0)),
    endsAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
  };
  const CUSTOM_B = {
    startsAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
    endsAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
  };

  it("folds an exactly-adjacent pair into one row", () => {
    expect(mergeAdjacentCustomRows([CUSTOM_B, CUSTOM_A])).toEqual([
      { startsAt: CUSTOM_A.startsAt, endsAt: CUSTOM_B.endsAt },
    ]);
  });

  it("leaves a one-minute gap alone", () => {
    const gapped = {
      ...CUSTOM_B,
      startsAt: new Date(CUSTOM_B.startsAt.getTime() + 60_000),
    };
    expect(mergeAdjacentCustomRows([CUSTOM_A, gapped])).toHaveLength(2);
  });

  it("folds an overlap and keeps the later end", () => {
    const overlapping = {
      startsAt: new Date(Date.UTC(2026, 8, 7, 10, 30)),
      endsAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
    };
    const contained = {
      startsAt: new Date(Date.UTC(2026, 8, 7, 10, 15)),
      endsAt: new Date(Date.UTC(2026, 8, 7, 10, 45)),
    };
    expect(mergeAdjacentCustomRows([CUSTOM_A, overlapping])).toEqual([
      { startsAt: CUSTOM_A.startsAt, endsAt: overlapping.endsAt },
    ]);
    expect(mergeAdjacentCustomRows([CUSTOM_A, contained])).toEqual([CUSTOM_A]);
  });

  it("is idempotent", () => {
    const once = mergeAdjacentCustomRows([CUSTOM_A, CUSTOM_B]);
    expect(mergeAdjacentCustomRows(once)).toEqual(once);
  });

  it("stops the fold at the twelve-hour bound", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 7, hour, 0));
    const eightHours = { startsAt: at(0), endsAt: at(8) };
    const nextEightHours = { startsAt: at(8), endsAt: at(16) };
    expect(mergeAdjacentCustomRows([eightHours, nextEightHours])).toHaveLength(
      2,
    );

    const fourHours = { startsAt: at(0), endsAt: at(4) };
    const thenEightHours = { startsAt: at(4), endsAt: at(12) };
    expect(mergeAdjacentCustomRows([fourHours, thenEightHours])).toEqual([
      { startsAt: at(0), endsAt: at(12) },
    ]);
  });
});

// Monday 2026-09-07 10:00–12:00 UTC as four 30-minute atoms across two rows.
function atom(
  startHourUtc: number,
  half: 0 | 1,
  rowId: string,
): TIntervalTiming & { isAllocated: boolean; bookingStatus: "available" } {
  const start = new Date(Date.UTC(2026, 8, 7, startHourUtc, half * 30));
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    slotId: `${rowId}-${start.toISOString()}`,
    dateInISO: start.toISOString(),
    dayOfWeek: "MONDAY",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    availabilityWindowId: rowId,
    appointmentOccurrenceId: "",
    localStartTime: "",
    localEndTime: "",
    type: "WEEKLY",
    isAllocated: false,
    bookingStatus: "available",
  };
}
const ATOMS = [
  atom(10, 0, "rowA"),
  atom(10, 1, "rowA"),
  atom(11, 0, "rowB"),
  atom(11, 1, "rowB"),
];

describe("mergeConsecutiveSlots (#1320)", () => {
  it("merges contiguous available atoms across row ids and keeps every covering id", () => {
    const merged = mergeConsecutiveSlots(ATOMS);
    expect(merged).toHaveLength(1);
    expect(merged[0].startsAt).toBe(ATOMS[0].startsAt);
    expect(merged[0].endsAt).toBe(ATOMS[3].endsAt);
    expect(merged[0].availabilityWindowId).toBe("rowA");
    expect(merged[0].availabilityWindowIds).toEqual(["rowA", "rowB"]);
  });

  it("does not merge across a booked atom or a time gap", () => {
    const booked = { ...ATOMS[2], isAllocated: true };
    expect(
      mergeConsecutiveSlots([ATOMS[0], ATOMS[1], booked, ATOMS[3]]),
    ).toHaveLength(3);
    expect(mergeConsecutiveSlots([ATOMS[0], ATOMS[3]])).toHaveLength(2);
  });

  // Adjacency is exact. A sub-minute tolerance would offer a window whose
  // uncovered seconds no row publishes, and checkout's union rule then
  // rejects the booking the grid promised.
  it.each([1_000, 60_000])("does not merge across a %dms gap", (gapMs) => {
    const shifted = {
      ...ATOMS[2],
      startsAt: new Date(
        new Date(ATOMS[2].startsAt).getTime() + gapMs,
      ).toISOString(),
    };
    expect(mergeConsecutiveSlots([ATOMS[0], ATOMS[1], shifted])).toHaveLength(
      2,
    );
  });

  it("keeps every id an already-merged slot carries", () => {
    const earlier = atom(9, 1, "rowZ"); // 09:30–10:00, ends where rowA starts
    const alreadyMerged = {
      ...ATOMS[0],
      endsAt: ATOMS[3].endsAt,
      availabilityWindowIds: ["rowA", "rowB"],
    };
    const merged = mergeConsecutiveSlots([earlier, alreadyMerged]);
    expect(merged).toHaveLength(1);
    expect(merged[0].availabilityWindowIds).toEqual(["rowZ", "rowA", "rowB"]);
  });
});

describe("breakDownSlotsPreservingStatus (#1320)", () => {
  it("offers a two-hour window at the row boundary the grid promises", () => {
    const windows = breakDownSlotsPreservingStatus(ATOMS, 2, "Asia/Kolkata");
    expect(windows.map((w) => `${w.startsAt}→${w.endsAt}`)).toEqual([
      `${ATOMS[0].startsAt}→${ATOMS[3].endsAt}`,
    ]);
  });

  it("still offers both one-hour windows", () => {
    const windows = breakDownSlotsPreservingStatus(ATOMS, 1, "Asia/Kolkata");
    expect(windows).toHaveLength(3); // 10:00, 10:30, 11:00 starts
  });
});

describe("checkout coverage rule (#1320)", () => {
  const start = new Date(Date.UTC(2026, 8, 7, 10, 0)); // Monday
  const end = new Date(Date.UTC(2026, 8, 7, 12, 0));

  it("a two-hour window spanning two adjacent rows is fully covered", () => {
    expect(
      findUncoveredAtom(windowAtoms(start, end), [ROW_A, ROW_B], []),
    ).toBeNull();
  });

  it("a window that crosses a gap reports the first uncovered atom", () => {
    const uncovered = findUncoveredAtom(
      windowAtoms(start, end),
      [ROW_A, ROW_GAP],
      [],
    );
    expect(uncovered?.start.toISOString()).toBe(
      new Date(Date.UTC(2026, 8, 7, 11, 0)).toISOString(),
    );
  });

  it("custom rows cover atoms too", () => {
    const custom = [
      {
        startsAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
        endsAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
      },
    ];
    expect(
      findUncoveredAtom(windowAtoms(start, end), [ROW_A], custom),
    ).toBeNull();
  });

  it("a trailing partial atom is tested by containment, not as a full atom", () => {
    // 10:00–10:45 against a custom row covering exactly that span: the
    // 10:30 atom only covers 15 window minutes, so testing it as a full
    // 30-minute atom (10:30–11:00) wrongly reported it uncovered.
    const partialStart = new Date(Date.UTC(2026, 8, 7, 10, 0));
    const partialEnd = new Date(Date.UTC(2026, 8, 7, 10, 45));
    const atoms = windowAtoms(partialStart, partialEnd);
    expect(atoms).toHaveLength(2);
    expect(atoms[1].end.toISOString()).toBe(partialEnd.toISOString());
    const custom = [{ startsAt: partialStart, endsAt: partialEnd }];
    expect(findUncoveredAtom(atoms, [], custom)).toBeNull();
  });

  it("whole atoms keep exact half-open semantics", () => {
    const atoms = windowAtoms(start, end);
    expect(atoms).toHaveLength(4);
    for (const atom of atoms) {
      expect(atom.end.getTime() - atom.start.getTime()).toBe(30 * 60 * 1000);
    }
  });

  it("checkout validates against the union, not the named row", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/payments/operations/checkout.ts"),
      "utf8",
    );
    expect(src).toContain("findUncoveredAtom(atoms, weeklyRows, customRows)");
    expect(src).not.toMatch(/isMinuteWithinWeeklySlot\(\s*candidateDay/);
  });

  it("every save path merges adjacent rows", () => {
    for (const f of [
      "utils/onboarding-server.ts",
      "app/api/user/consultants/[id]/route.ts",
    ]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src).toContain("mergeAdjacentWeeklyRows(");
      expect(src).toContain("mergeAdjacentCustomRows(");
    }
    for (const [f, helper] of [
      [
        "app/api/scheduling/availability/weekly/route.ts",
        "coalesceAndResolve(",
      ],
      [
        "app/api/scheduling/availability/weekly/[id]/route.ts",
        "coalesceAndResolve(",
      ],
      [
        "app/api/scheduling/availability/custom/route.ts",
        "coalesceAndResolveCustom(",
      ],
      [
        "app/api/scheduling/availability/custom/[id]/route.ts",
        "coalesceAndResolveCustom(",
      ],
    ]) {
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).toContain(
        helper,
      );
    }
  });
});

/**
 * The covering-row lookup is a containment test WITHIN one local day pair.
 * Without `localEndDay` an overnight row (end < start) matches any same-day
 * row that starts earlier, so an edit is answered with someone else's window.
 */
describe("coalesceAndResolve resolves the edited row (#1320)", () => {
  const SAME_DAY = { id: "same-day", ...localRow("MONDAY", 540, 1080) };
  const OVERNIGHT = {
    id: "overnight",
    ...localRow("MONDAY", 1320, 120, "TUESDAY"),
  };
  type StoredRow = typeof SAME_DAY;

  function weeklyDb(rows: StoredRow[]) {
    return {
      availabilityWindowWeekly: {
        findMany: async () => rows,
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
        findFirst: async ({
          where,
        }: {
          where: {
            localStartDay: string;
            localEndDay: string;
            localStartMinutes: { lte: number };
            localEndMinutes: { gte: number };
          };
        }) =>
          rows.find(
            (r) =>
              r.localStartDay === where.localStartDay &&
              r.localEndDay === where.localEndDay &&
              r.localStartMinutes <= where.localStartMinutes.lte &&
              r.localEndMinutes >= where.localEndMinutes.gte,
          ) ?? null,
      },
    } as unknown as Pick<Tx, "availabilityWindowWeekly">;
  }

  it("answers an overnight edit with the overnight row, not a same-day one", async () => {
    const covering = await coalesceAndResolve(
      weeklyDb([SAME_DAY, OVERNIGHT]),
      "cp-1",
      OVERNIGHT,
    );
    expect(covering?.id).toBe("overnight");
  });
});

describe("loadPublishedCoverage (#1320)", () => {
  function coverageDb(deletedAt: Date | null) {
    return {
      consultantProfile: {
        findUnique: async () => ({ scheduleType: "WEEKLY", deletedAt }),
      },
      availabilityWindowWeekly: { findMany: async () => [ROW_A, ROW_B] },
      availabilityWindowCustom: { findMany: async () => [] },
    } as unknown as Pick<
      Tx,
      | "consultantProfile"
      | "availabilityWindowWeekly"
      | "availabilityWindowCustom"
    >;
  }
  const start = new Date(Date.UTC(2026, 8, 7, 10, 0));
  const end = new Date(Date.UTC(2026, 8, 7, 12, 0));

  it("publishes the active arm for a live profile", async () => {
    const coverage = await loadPublishedCoverage(
      coverageDb(null),
      "cp-1",
      start,
      end,
    );
    expect(coverage.weeklyRows).toHaveLength(2);
    expect(
      findUncoveredAtom(windowAtoms(start, end), coverage.weeklyRows, []),
    ).toBeNull();
  });

  // Rows outlive a soft-deleted profile, and checkout can reach this loader
  // without ever seeing the named row. Publishing them would sell a session
  // with an expert who no longer takes bookings.
  it("publishes nothing for a soft-deleted profile", async () => {
    const coverage = await loadPublishedCoverage(
      coverageDb(new Date()),
      "cp-1",
      start,
      end,
    );
    expect(coverage).toEqual({
      scheduleType: null,
      weeklyRows: [],
      customRows: [],
    });
    expect(
      findUncoveredAtom(windowAtoms(start, end), coverage.weeklyRows, []),
    ).not.toBeNull();
  });
});
