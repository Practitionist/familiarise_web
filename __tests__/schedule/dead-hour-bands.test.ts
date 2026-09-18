/**
 * #1703 F1 — the dead-hour fold. Rows with nothing live anywhere in the
 * visible week collapse into one strip per contiguous band; a week with no
 * live rows folds nothing, so the consultant still sees where the day is.
 */
import {
  bandKey,
  foldDeadHourBands,
  nearestVisibleRow,
} from "@/lib/scheduling/dead-hour-bands";

const live = (from: number, to: number, total = 48) =>
  Array.from({ length: total }, (_, row) => row >= from && row < to);

describe("foldDeadHourBands", () => {
  it("folds the hours before and after a 09:00–19:00 window", () => {
    const folded = foldDeadHourBands(live(18, 38));
    expect(folded.allDead).toBe(false);
    expect(folded.segments).toEqual([
      { kind: "band", from: 0, to: 18 },
      { kind: "rows", from: 18, to: 38 },
      { kind: "band", from: 38, to: 48 },
    ]);
  });

  it("keeps a lunch gap as its own band", () => {
    const rows = live(18, 24).map(
      (value, row) => value || (row >= 28 && row < 36),
    );
    expect(foldDeadHourBands(rows).segments.map((s) => s.kind)).toEqual([
      "band",
      "rows",
      "band",
      "rows",
      "band",
    ]);
  });

  it("shows the whole day, flagged, when nothing is live", () => {
    expect(foldDeadHourBands(live(0, 0))).toEqual({
      segments: [{ kind: "rows", from: 0, to: 48 }],
      allDead: true,
    });
  });

  it("gives each band a key the session can remember", () => {
    expect(bandKey({ kind: "band", from: 38, to: 48 })).toBe("38-48");
  });
});

describe("nearestVisibleRow", () => {
  it("lands on the first rendered row at or after a folded target", () => {
    expect(nearestVisibleRow(10, [18, 19, 20])).toBe(18);
    expect(nearestVisibleRow(19, [18, 19, 20])).toBe(19);
    expect(nearestVisibleRow(40, [18, 19, 20])).toBe(20);
    expect(nearestVisibleRow(5, [])).toBeNull();
  });
});
