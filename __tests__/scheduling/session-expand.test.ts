import { splitIntoSessions } from "@/lib/scheduling/calendarUtils";
import { expandToSession } from "@/lib/scheduling/week-grid-model";

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
