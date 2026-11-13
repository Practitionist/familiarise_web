/**
 * The single-time picker's options: a host sees free, booked and outside-hours
 * starts on the half-hour lattice; a buyer is offered only the windows
 * `windowsForDay` makes bookable, sees a held window as contended, and the
 * taken list (booked or held, in published hours) leaves out past and
 * too-soon times. A session that
 * crosses midnight is one option on the day it starts.
 */

import {
  atomIndex,
  buyerTimeOptions,
  monthSummary,
  optionsForDay,
  singleSessionOptions,
  singleTimeLeadMs,
  takenTimes,
  takenTimesToggleLabel,
} from "@/lib/scheduling/single-session-options";

const HOUR = 3_600_000;
const DAY_START = Date.parse("2026-11-20T00:00:00.000Z");

function cell(startH: number, endH: number, bookingStatus = "available") {
  return {
    startsAt: new Date(DAY_START + startH * HOUR).toISOString(),
    endsAt: new Date(DAY_START + endH * HOUR).toISOString(),
    bookingStatus: bookingStatus as "available" | "fully-booked",
  };
}

/** Half-hour atoms from `startH` to `endH`, booked where `booked` says. */
function atoms(startH: number, endH: number, booked: number[] = []) {
  const out = [];
  for (let h = startH; h < endH; h += 0.5) {
    out.push(
      cell(h, h + 0.5, booked.includes(h) ? "fully-booked" : "available"),
    );
  }
  return out;
}

describe("singleSessionOptions (host)", () => {
  // Published 09:00–12:00 UTC; 10:00–10:30 is booked.
  const index = atomIndex({
    "2026-11-20": [cell(9, 10), cell(10, 10.5, "fully-booked"), cell(10.5, 12)],
  } as never);
  const options = singleSessionOptions({
    atoms: index,
    dayStartMs: DAY_START,
    dayEndMs: DAY_START + 24 * HOUR,
    sessionMinutes: 60,
    notBeforeMs: DAY_START + 8 * HOUR,
    allowedEndMs: DAY_START + 23 * HOUR,
  });
  const at = (h: number) =>
    options.find((o) => o.startMs === DAY_START + h * HOUR);

  it("labels each start and leaves out starts past the allowed window", () => {
    expect(at(7)?.state).toBe("too-soon");
    expect(at(8)?.state).toBe("outside-hours");
    expect(at(9)?.state).toBe("free");
    expect(at(9.5)?.state).toBe("taken");
    expect(at(11)?.state).toBe("free");
    expect(at(11.5)?.state).toBe("outside-hours");
    expect(at(22.5)).toBeUndefined();
    expect(at(8)?.selectable && at(11)?.selectable).toBe(true);
    expect(at(9.5)?.selectable || at(7)?.selectable).toBe(false);
  });
});

describe("buyerTimeOptions", () => {
  const base = {
    dayStartMs: DAY_START,
    dayEndMs: DAY_START + 24 * HOUR,
    sessionMinutes: 60,
    zone: "UTC",
    leadMs: singleTimeLeadMs("book"),
  };

  it("offers free windows and lists booked and held ones as taken, in time order", () => {
    // 09:00–14:00 published; 12:00–12:30 booked; now is 09:40.
    const options = buyerTimeOptions({
      ...base,
      atoms: atoms(9, 14, [12]),
      nowMs: DAY_START + 9 * HOUR + 40 * 60_000,
      heldStarts: new Set([DAY_START + 13 * HOUR]),
    });
    const state = (h: number) =>
      options.find((o) => o.startMs === DAY_START + h * HOUR)?.state;
    expect(state(9)).toBeUndefined(); // past
    expect(state(9.5)).toBeUndefined(); // too soon, not counted
    expect(state(10)).toBe("free");
    expect(state(11.5)).toBe("taken");
    expect(state(12)).toBe("taken");
    expect(state(13)).toBe("contended");
    expect(state(13.5)).toBeUndefined(); // runs past published hours
    expect(
      takenTimes(options).map((o) => (o.startMs - DAY_START) / HOUR),
    ).toEqual([11.5, 12, 13]);
    expect(takenTimesToggleLabel(3, false)).toBe("Show 3 taken times");
    expect(takenTimesToggleLabel(1, false)).toBe("Show 1 taken time");
    expect(takenTimesToggleLabel(1, true)).toBe("Hide taken times");
  });

  it("keeps a stored 15-minute length instead of stretching it to 30", () => {
    const [first] = buyerTimeOptions({
      ...base,
      sessionMinutes: 15,
      atoms: atoms(10, 11),
      nowMs: DAY_START,
    });
    expect(first.endMs - first.startMs).toBe(15 * 60_000);
  });

  it("keeps a session across midnight on the day it starts", () => {
    const options = optionsForDay(new Date(2026, 10, 20, 12), {
      audience: "buyer",
      data: {
        "2026-11-20": atoms(23, 24),
        "2026-11-21": atoms(24, 25),
      } as never,
      zone: "UTC",
      sessionMinutes: 60,
      nowMs: DAY_START,
      leadMs: singleTimeLeadMs("book"),
    });
    expect(options.map((o) => [o.startMs, o.state])).toEqual([
      [DAY_START + 23 * HOUR, "free"],
      [DAY_START + 23.5 * HOUR, "free"],
    ]);
  });
});

describe("lead per writer", () => {
  it("reads each writer's own lead", () => {
    expect(singleTimeLeadMs("create")).toBe(HOUR);
    expect(singleTimeLeadMs("retime")).toBe(24 * HOUR);
    expect(singleTimeLeadMs("reschedule")).toBe(24 * HOUR);
    expect(singleTimeLeadMs("request", false)).toBe(2 * HOUR);
    expect(singleTimeLeadMs("book")).toBe(15 * 60_000);
  });
});

describe("monthSummary", () => {
  it("marks a day free only when it has a free time for that audience", () => {
    const days = [20, 21, 22].map((d) => new Date(2026, 10, d, 12));
    const data = {
      "2026-11-20": atoms(9, 10, [9, 9.5]),
      "2026-11-21": atoms(33, 34),
    } as never;
    const input = {
      data,
      zone: "UTC",
      sessionMinutes: 60,
      nowMs: DAY_START - 24 * HOUR,
      leadMs: singleTimeLeadMs("create"),
    };
    expect([
      ...monthSummary(days, { ...input, audience: "buyer" }).values(),
    ]).toEqual([false, true, false]);
    expect([
      ...monthSummary(days, { ...input, audience: "host" }).values(),
    ]).toEqual([false, true, false]);
  });
});
