import { splitIntoSessions } from "@/lib/scheduling/calendarUtils";
import {
  expandToSession,
  fitLabel,
  sessionsThatFit,
  weekDayFits,
} from "@/lib/scheduling/week-grid-model";

const ATOM = 30 * 60 * 1000;
const T0 = Date.UTC(2030, 5, 12, 10, 0);

/** Free atoms at these offsets (in half-hours) from T0. */
function freeAt(...offsets: number[]) {
  const free = new Set(offsets.map((offset) => T0 + offset * ATOM));
  return (startMs: number) => free.has(startMs);
}

const offsets = (starts: number[]) => starts.map((ms) => (ms - T0) / ATOM);

describe("expandToSession", () => {
  it("grows forward from the click when the session fits there", () => {
    expect(offsets(expandToSession(T0, 3, freeAt(0, 1, 2, -1)))).toEqual([
      0, 1, 2,
    ]);
  });

  it("grows backward when forward is blocked", () => {
    expect(offsets(expandToSession(T0, 2, freeAt(0, -1)))).toEqual([-1, 0]);
  });

  it("grows both ways around the click when neither side fits alone", () => {
    expect(offsets(expandToSession(T0, 3, freeAt(-1, 0, 1)))).toEqual([
      -1, 0, 1,
    ]);
  });

  it("returns just the click when no whole session fits", () => {
    expect(offsets(expandToSession(T0, 3, freeAt(0, 1)))).toEqual([0]);
    expect(offsets(expandToSession(T0, 1, freeAt()))).toEqual([0]);
  });
});

describe("splitIntoSessions", () => {
  const atom = (offset: number) => ({
    startTime: new Date(T0 + offset * ATOM),
    endTime: new Date(T0 + (offset + 1) * ATOM),
    isAvailable: true,
    isBooked: false,
  });

  it("keeps two back-to-back picks as two sessions", () => {
    const sessions = splitIntoSessions(
      [atom(0), atom(1), atom(2), atom(3)],
      2,
      "UTC",
    );
    expect(
      sessions.map((s) => [
        (s.start.getTime() - T0) / ATOM,
        (s.end.getTime() - T0) / ATOM,
      ]),
    ).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("leaves a short tail as its own piece", () => {
    expect(splitIntoSessions([atom(0), atom(1), atom(2)], 2, "UTC")).toEqual([
      { start: new Date(T0), end: new Date(T0 + 2 * ATOM) },
      { start: new Date(T0 + 2 * ATOM), end: new Date(T0 + 3 * ATOM) },
    ]);
  });
});

describe("sessionsThatFit", () => {
  it("counts whole sessions per unbroken free run", () => {
    // Runs of 3 and 2 half-hours, split by a booking: one 1-hour session each.
    const starts = [0, 1, 2, 4, 5].map((i) => T0 + i * ATOM);
    expect(sessionsThatFit(starts, 2)).toBe(2);
    expect(sessionsThatFit(starts, 3)).toBe(1);
    expect(sessionsThatFit(starts, 1)).toBe(5);
    expect(sessionsThatFit([], 2)).toBe(0);
  });
});

describe("weekDayFits", () => {
  it("counts only free cells, per day column", () => {
    const cell = (i: number, statusKey: "available" | "fullyBooked") => ({
      startMs: T0 + i * ATOM,
      statusKey,
    });
    expect(
      weekDayFits(
        [
          [cell(0, "available"), cell(100, "available")],
          [cell(1, "available"), null],
          [cell(2, "fullyBooked"), cell(102, "available")],
        ],
        2,
      ),
    ).toEqual([1, 0]);
  });

  it("labels the count the way the header prints it", () => {
    expect([0, 1, 4].map(fitLabel)).toEqual(["None fit", "1 fits", "4 fit"]);
  });
});
