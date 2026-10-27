/**
 * @jest-environment node
 */

/**
 * Busy time outside the published windows paints one cell per 30-minute UTC
 * atom it touches, never one stretched cell, and never on top of an existing
 * cell. Live data has occurrences off the :00/:30 grid and longer than 30 min.
 */

import { synthesizeOrphanCells } from "@/utils/scheduling-engine/intervals";

const RANGE = {
  rangeStart: new Date("2026-09-07T00:00:00.000Z"),
  rangeEnd: new Date("2026-09-08T00:00:00.000Z"),
  timezone: "UTC",
  type: "WEEKLY" as const,
};

const spans = (cells: { startsAt: string; endsAt: string }[]) =>
  cells.map((c) => [c.startsAt.slice(11, 16), c.endsAt.slice(11, 16)]);

function expectNoOverlap(cells: { startsAt: string; endsAt: string }[]) {
  const sorted = [...cells].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
  for (let i = 1; i < sorted.length; i++) {
    expect(Date.parse(sorted[i].startsAt)).toBeGreaterThanOrEqual(
      Date.parse(sorted[i - 1].endsAt),
    );
  }
}

describe("synthesizeOrphanCells", () => {
  it("snaps an off-grid 10:17–11:05 occurrence to the atoms it covers", () => {
    const cells = synthesizeOrphanCells({
      ...RANGE,
      existing: [],
      occupied: [
        {
          startsAt: new Date("2026-09-07T10:17:00.000Z"),
          endsAt: new Date("2026-09-07T11:05:00.000Z"),
        },
      ],
    });
    expect(spans(cells)).toEqual([
      ["10:00", "10:30"],
      ["10:30", "11:00"],
      ["11:00", "11:30"],
    ]);
    expect(cells.every((c) => c.bookingStatus === "fully-booked")).toBe(true);
    expect(cells.every((c) => c.isAllocated)).toBe(true);
    expect(new Set(cells.map((c) => c.slotId)).size).toBe(cells.length);
  });

  it("paints a 90-minute occurrence as three one-atom cells", () => {
    const cells = synthesizeOrphanCells({
      ...RANGE,
      existing: [],
      occupied: [
        {
          startsAt: "2026-09-07T14:00:00.000Z",
          endsAt: "2026-09-07T15:30:00.000Z",
        },
      ],
    });
    expect(spans(cells)).toEqual([
      ["14:00", "14:30"],
      ["14:30", "15:00"],
      ["15:00", "15:30"],
    ]);
  });

  it("skips atoms an existing cell already covers and dedupes overlapping rows", () => {
    const cells = synthesizeOrphanCells({
      ...RANGE,
      existing: [
        {
          startsAt: "2026-09-07T14:00:00.000Z",
          endsAt: "2026-09-07T14:30:00.000Z",
        },
      ],
      occupied: [
        {
          startsAt: "2026-09-07T14:00:00.000Z",
          endsAt: "2026-09-07T15:30:00.000Z",
        },
        // A second row (consultee arm) over the same time paints nothing new.
        {
          startsAt: "2026-09-07T14:45:00.000Z",
          endsAt: "2026-09-07T15:15:00.000Z",
        },
      ],
    });
    expect(spans(cells)).toEqual([
      ["14:30", "15:00"],
      ["15:00", "15:30"],
    ]);
    expectNoOverlap([
      ...cells,
      {
        startsAt: "2026-09-07T14:00:00.000Z",
        endsAt: "2026-09-07T14:30:00.000Z",
      },
    ]);
  });

  it("never overlaps an off-grid existing cell", () => {
    const existing = [
      {
        startsAt: "2026-09-07T09:45:00.000Z",
        endsAt: "2026-09-07T10:15:00.000Z",
      },
    ];
    const cells = synthesizeOrphanCells({
      ...RANGE,
      existing,
      occupied: [
        {
          startsAt: "2026-09-07T10:00:00.000Z",
          endsAt: "2026-09-07T11:00:00.000Z",
        },
      ],
    });
    expect(spans(cells)).toEqual([["10:30", "11:00"]]);
    expectNoOverlap([...cells, ...existing]);
  });

  it("clips to the requested range, keeping the tail of an earlier start", () => {
    const cells = synthesizeOrphanCells({
      ...RANGE,
      existing: [],
      occupied: [
        {
          startsAt: "2026-09-06T23:30:00.000Z",
          endsAt: "2026-09-07T00:40:00.000Z",
        },
        {
          startsAt: "2026-09-07T23:30:00.000Z",
          endsAt: "2026-09-08T01:00:00.000Z",
        },
      ],
    });
    expect(cells.map((c) => c.startsAt)).toEqual([
      "2026-09-07T00:00:00.000Z",
      "2026-09-07T00:30:00.000Z",
      "2026-09-07T23:30:00.000Z",
    ]);
  });

  it("labels cells in the viewer's zone", () => {
    const [cell] = synthesizeOrphanCells({
      ...RANGE,
      timezone: "Asia/Kolkata",
      existing: [],
      occupied: [
        {
          startsAt: "2026-09-07T10:00:00.000Z",
          endsAt: "2026-09-07T10:30:00.000Z",
        },
      ],
    });
    expect(cell.localStartTime).toBe("3:30 PM");
    expect(cell.localEndTime).toBe("4:00 PM");
    expect(cell.dayOfWeek).toBe("MONDAY");
  });
});
