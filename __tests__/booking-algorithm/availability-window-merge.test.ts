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
import { mergeAdjacentWeeklyRows } from "../../utils/slotAllocation/mergeAdjacentWeeklyRows";
import {
  findUncoveredAtom,
  windowAtoms,
} from "../../utils/slotAllocation/availabilityCoverage";
import {
  breakDownSlotsPreservingStatus,
  mergeConsecutiveSlots,
} from "../../utils/timeSlotsProcessing";
import type { TSlotTiming } from "../../types/slots";

// The live rows from the report: Monday 10:00–11:00 and 11:00–12:00 UTC
// (15:30–17:30 IST), stored as two 60-minute rows.
const ROW_A = {
  startDay: "MONDAY" as const,
  endDay: "MONDAY" as const,
  startTimeUtc: 600,
  endTimeUtc: 660,
  utcOffsetMinutes: 330,
};
const ROW_B = {
  startDay: "MONDAY" as const,
  endDay: "MONDAY" as const,
  startTimeUtc: 660,
  endTimeUtc: 720,
  utcOffsetMinutes: 330,
};
const ROW_GAP = {
  startDay: "MONDAY" as const,
  endDay: "MONDAY" as const,
  startTimeUtc: 840,
  endTimeUtc: 900,
  utcOffsetMinutes: 330,
};

describe("mergeAdjacentWeeklyRows", () => {
  it("folds exactly-adjacent same-day rows into one and leaves gaps alone", () => {
    const merged = mergeAdjacentWeeklyRows([ROW_GAP, ROW_B, ROW_A]);
    expect(merged).toEqual([{ ...ROW_A, endTimeUtc: 720 }, ROW_GAP]);
  });

  it("never merges across days, offsets, or overnight rows", () => {
    const tue = {
      ...ROW_B,
      startDay: "TUESDAY" as const,
      endDay: "TUESDAY" as const,
    };
    const otherOffset = { ...ROW_B, utcOffsetMinutes: -180 };
    const overnight = {
      startDay: "MONDAY" as const,
      endDay: "TUESDAY" as const,
      startTimeUtc: 1380,
      endTimeUtc: 60,
      utcOffsetMinutes: 330,
    };
    expect(mergeAdjacentWeeklyRows([ROW_A, tue])).toHaveLength(2);
    expect(mergeAdjacentWeeklyRows([ROW_A, otherOffset])).toHaveLength(2);
    expect(
      mergeAdjacentWeeklyRows([{ ...ROW_A, endTimeUtc: 1380 }, overnight]),
    ).toHaveLength(2);
  });

  it("is idempotent", () => {
    const once = mergeAdjacentWeeklyRows([ROW_A, ROW_B]);
    expect(mergeAdjacentWeeklyRows(once)).toEqual(once);
  });
});

// Monday 2026-09-07 10:00–12:00 UTC as four 30-minute atoms across two rows.
function atom(
  startHourUtc: number,
  half: 0 | 1,
  rowId: string,
): TSlotTiming & { isAllocated: boolean; bookingStatus: "available" } {
  const start = new Date(Date.UTC(2026, 8, 7, startHourUtc, half * 30));
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    slotId: `${rowId}-${start.toISOString()}`,
    dateInISO: start.toISOString(),
    dayOfWeek: "MONDAY",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    slotOfAvailabilityId: rowId,
    slotOfAppointmentId: "",
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
    expect(merged[0].slotOfAvailabilityId).toBe("rowA");
    expect(merged[0].slotOfAvailabilityIds).toEqual(["rowA", "rowB"]);
  });

  it("does not merge across a booked atom or a time gap", () => {
    const booked = { ...ATOMS[2], isAllocated: true };
    expect(
      mergeConsecutiveSlots([ATOMS[0], ATOMS[1], booked, ATOMS[3]]),
    ).toHaveLength(3);
    expect(mergeConsecutiveSlots([ATOMS[0], ATOMS[3]])).toHaveLength(2);
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
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).toContain(
        "mergeAdjacentWeeklyRows(",
      );
    }
    for (const f of [
      "app/api/slots/availability/weekly/route.ts",
      "app/api/slots/availability/weekly/[id]/route.ts",
    ]) {
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).toContain(
        "coalesceAndResolve(",
      );
    }
  });
});
