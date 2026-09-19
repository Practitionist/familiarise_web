/**
 * Allocate reschedule count — canonical predicate regression test.
 *
 * Screenshot RCA: "This reschedule requires exactly 12 slots (replacing 6
 * session(s)), but 8 were provided." The allocator counted bare `isTentative`
 * rows (6, incl. fresh-request holds and stale/tombstoned duplicates) while
 * the Allocate page caps to plan totalSessions (4 x 2 slots = 8). The fix
 * counts only live releases via `isReleasedForReschedule`
 * (tentative + RESCHEDULED + deletedAt == null).
 */
import fs from "fs";
import path from "path";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";

describe("isReleasedForReschedule — the reschedule identity", () => {
  it("counts a live tentative + RESCHEDULED release", () => {
    expect(
      isReleasedForReschedule({
        isTentative: true,
        completionStatus: "RESCHEDULED",
        deletedAt: null,
      }),
    ).toBe(true);
  });

  it("ignores a fresh request's tentative hold (never released)", () => {
    expect(
      isReleasedForReschedule({
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
      }),
    ).toBe(false);
  });

  it("ignores tombstoned releases (history, not a live hold)", () => {
    expect(
      isReleasedForReschedule({
        isTentative: true,
        completionStatus: "RESCHEDULED",
        deletedAt: new Date(),
      }),
    ).toBe(false);
  });

  it("ignores non-tentative rows even when RESCHEDULED", () => {
    expect(
      isReleasedForReschedule({
        isTentative: false,
        completionStatus: "RESCHEDULED",
        deletedAt: null,
      }),
    ).toBe(false);
  });
});

describe("SchedulingService source contract — reschedule counts releases, not tentatives", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "utils/scheduling-engine/SchedulingService.ts",
    ),
    "utf8",
  );

  it("derives isReschedule from the canonical release count", () => {
    expect(source).toContain("releasedSessionCountOf(existingAppointments)");
  });

  it("no longer counts bare tentatives for reschedule sessions", () => {
    // Both allocate paths (auto + manual) declare `const rescheduleSessions`.
    const declarations = [
      ...source.matchAll(/const rescheduleSessions =([\s\S]{0,160}?);/g),
    ];
    expect(declarations.length).toBeGreaterThanOrEqual(2);
    for (const m of declarations) {
      expect(m[1]).toContain("releasedSessionCountOf");
      expect(m[1]).not.toContain("isTentative");
    }
  });

  it("excludes only released rows from conflict detection on reschedule", () => {
    expect(source).toContain(
      "this.releasedOccurrenceIdsOf(existingAppointments)",
    );
  });
});
