/** @jest-environment node */

import {
  formatDuration,
  outcomeLabel,
  scalarFields,
  summaryFields,
} from "../../lib/cron/run-display";

describe("run display", () => {
  it("labels a recorded outcome and rejects anything else", () => {
    expect(outcomeLabel("attention")).toBe("Needs attention");
    expect(outcomeLabel("nonsense")).toBeNull();
    expect(outcomeLabel(null)).toBeNull();
  });

  it("never stringifies an object and skips bookkeeping keys", () => {
    expect(
      scalarFields(
        {
          outcome: "completed",
          nested: { a: 1 },
          list: [1],
          reaped: 3,
          ok: true,
        },
        3,
      ),
    ).toEqual(["reaped: 3", "ok: true"]);
  });

  it("reads the stored summary of a new row and the flat fields of an old one", () => {
    expect(
      summaryFields(
        { outcome: "completed", summary: { a: 1, b: { c: 2 }, d: 4 } },
        2,
      ),
    ).toEqual(["a: 1", "d: 4"]);
    expect(summaryFields({ cleanedCount: 2 }, 3)).toEqual(["cleanedCount: 2"]);
  });

  it("formats durations", () => {
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
  });
});
