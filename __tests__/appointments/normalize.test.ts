/**
 * @jest-environment node
 */

/**
 * The read-side boundary for stored booking times: impossible intervals are
 * dropped or bounded before any timeline, list or grid draws them, off-grid
 * times survive untouched, and each anomaly is collected once.
 */

import {
  MAX_SESSION_MS,
  anomalyCollector,
  normalizeOccurrences,
  occupiedIntervalsIn,
  sessionGapOf,
} from "@/lib/appointments/normalize";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

describe("normalizeOccurrences", () => {
  it("drops inverted, zero-length and unreadable rows and names each one", () => {
    const { sink, anomalies } = anomalyCollector();
    const kept = normalizeOccurrences(
      [
        {
          id: "ok",
          startsAt: at("2026-09-07T10:00:00Z"),
          endsAt: at("2026-09-07T11:00:00Z"),
        },
        {
          id: "inverted",
          startsAt: at("2026-09-07T11:00:00Z"),
          endsAt: at("2026-09-07T10:00:00Z"),
        },
        {
          id: "zero",
          startsAt: at("2026-09-07T11:00:00Z"),
          endsAt: at("2026-09-07T11:00:00Z"),
        },
        {
          id: "bad-start",
          startsAt: "not a time",
          endsAt: at("2026-09-07T11:00:00Z"),
        },
        { id: "bad-end", startsAt: at("2026-09-07T11:00:00Z"), endsAt: "soon" },
      ],
      sink,
    );
    expect(kept.map((r) => r.id)).toEqual(["ok"]);
    expect(anomalies()).toEqual([
      { kind: "ENDS_BEFORE_START", id: "inverted" },
      { kind: "ENDS_BEFORE_START", id: "zero" },
      { kind: "UNREADABLE_TIME", id: "bad-start" },
      { kind: "UNREADABLE_TIME", id: "bad-end" },
    ]);
  });

  it("pulls an absurd end back to the longest session, keeping the row's date shape", () => {
    const { sink, anomalies } = anomalyCollector();
    const [asDate, asString] = normalizeOccurrences(
      [
        {
          id: "d",
          startsAt: at("2026-09-07T10:00:00Z"),
          endsAt: at("2027-09-07T10:00:00Z"),
        },
        {
          id: "s",
          startsAt: "2026-09-07T10:00:00.000Z",
          endsAt: "2026-09-17T10:00:00.000Z",
        },
      ],
      sink,
    );
    expect(asDate.endsAt).toEqual(
      new Date(Date.parse("2026-09-07T10:00:00Z") + MAX_SESSION_MS),
    );
    expect(asString.endsAt).toBe(
      new Date(
        Date.parse("2026-09-07T10:00:00Z") + MAX_SESSION_MS,
      ).toISOString(),
    );
    expect(anomalies().map((a) => a.kind)).toEqual([
      "OVERLONG_SESSION",
      "OVERLONG_SESSION",
    ]);
  });

  it("keeps off-grid times and missing ends exactly as stored", () => {
    const offGrid = {
      id: "x",
      startsAt: at("2026-09-07T10:17:43Z"),
      endsAt: at("2026-09-07T11:05:00Z"),
    };
    const open = {
      id: "y",
      startsAt: at("2026-09-07T12:00:00Z"),
      endsAt: null,
    };
    const kept = normalizeOccurrences([offGrid, open]);
    expect(kept[0]).toBe(offGrid);
    expect(kept[1]).toBe(open);
  });

  it("treats a missing list as empty", () => {
    expect(normalizeOccurrences(null)).toEqual([]);
    expect(normalizeOccurrences(undefined)).toEqual([]);
  });
});

describe("occupiedIntervalsIn", () => {
  const range = {
    start: at("2026-09-07T00:00:00Z"),
    end: at("2026-09-08T00:00:00Z"),
  };

  it("clips to the window and keeps overlong rows whole up to the clip", () => {
    const { sink, anomalies } = anomalyCollector();
    const intervals = occupiedIntervalsIn(
      [
        {
          id: "multi-year",
          startsAt: at("2025-01-01T00:00:00Z"),
          endsAt: at("2030-01-01T00:00:00Z"),
        },
        {
          id: "inside",
          startsAt: at("2026-09-07T10:15:00Z"),
          endsAt: at("2026-09-07T11:15:00Z"),
        },
        {
          id: "outside",
          startsAt: at("2026-09-09T10:00:00Z"),
          endsAt: at("2026-09-09T11:00:00Z"),
        },
        {
          id: "inverted",
          startsAt: at("2026-09-07T12:00:00Z"),
          endsAt: at("2026-09-07T11:00:00Z"),
        },
      ],
      range,
      sink,
    );
    expect(intervals).toEqual([
      { id: "multi-year", startsAt: range.start, endsAt: range.end },
      {
        id: "inside",
        startsAt: at("2026-09-07T10:15:00Z"),
        endsAt: at("2026-09-07T11:15:00Z"),
      },
    ]);
    expect(anomalies()).toEqual([
      { kind: "OVERLONG_SESSION", id: "multi-year" },
      { kind: "ENDS_BEFORE_START", id: "inverted" },
    ]);
  });
});

describe("sessionGapOf", () => {
  it("separates a plan awaiting its first session from a booking that lost them", () => {
    expect(sessionGapOf({ kind: "SUBSCRIPTION", rows: 0, liveRows: 0 })).toBe(
      "AWAITING_SCHEDULING",
    );
    expect(sessionGapOf({ kind: "SUBSCRIPTION", rows: 3, liveRows: 0 })).toBe(
      "NEEDS_RESCHEDULING",
    );
    expect(sessionGapOf({ kind: "CONSULTATION", rows: 0, liveRows: 0 })).toBe(
      "NEEDS_RESCHEDULING",
    );
    expect(
      sessionGapOf({ kind: "CONSULTATION", rows: 1, liveRows: 1 }),
    ).toBeNull();
  });
});

describe("anomalyCollector", () => {
  it("keeps one anomaly per kind and id", () => {
    const { sink, anomalies } = anomalyCollector();
    sink({ kind: "ENDS_BEFORE_START", id: "a" });
    sink({ kind: "ENDS_BEFORE_START", id: "a" });
    sink({ kind: "OVERLONG_SESSION", id: "a" });
    expect(anomalies()).toHaveLength(2);
  });

  it("is linear on a 10k-row series", () => {
    const start = Date.parse("2026-01-05T09:00:00Z");
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      id: `o${i}`,
      startsAt: new Date(start + i * 24 * HOUR),
      endsAt: new Date(start + i * 24 * HOUR + HOUR),
    }));
    const t0 = Date.now();
    expect(normalizeOccurrences(rows)).toHaveLength(10_000);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
