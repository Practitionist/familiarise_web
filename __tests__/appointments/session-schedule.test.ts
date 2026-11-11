import { formatInTimeZone } from "date-fns-tz";
import {
  buildScheduleModel,
  lengthLabel,
  timeRangeLabel,
  weekRangeLabel,
} from "@/lib/appointments/session-schedule";

const at = (iso: string, minutes = 60) => ({
  key: iso,
  startsAt: new Date(iso),
  endsAt: new Date(new Date(iso).getTime() + minutes * 60_000),
});

describe("buildScheduleModel", () => {
  it("numbers sessions in start order and groups them into weeks of the zone's calendar", () => {
    const model = buildScheduleModel(
      [
        at("2026-11-23T03:30:00Z"), // Mon 09:00 IST
        at("2026-11-22T10:00:00Z"), // Sun 15:30 IST
        at("2026-11-29T09:00:00Z"), // Sun 14:30 IST, week 2
      ],
      "Asia/Kolkata",
      { sessionsPerWeek: 2 },
    );
    expect(model.sessions.map((s) => s.number)).toEqual([1, 2, 3]);
    expect(model.sessions[0].localDay).toBe("2026-11-22");
    expect(model.weeks.map((w) => w.sessions.length)).toEqual([2, 1]);
    expect(model.weeks[1].short).toBe(true);
    expect(model.weeks[0].short).toBe(false);
    expect(model.multiWeek).toBe(true);
  });

  it("splits weeks at the zone's midnight, not the runtime's", () => {
    // 20:00 UTC on Sat 28 Nov is 01:30 Sun 29 Nov in IST: one week after Sun 22.
    const model = buildScheduleModel(
      [at("2026-11-22T10:00:00Z"), at("2026-11-28T20:00:00Z")],
      "Asia/Kolkata",
    );
    expect(model.weeks).toHaveLength(2);
    expect(model.weeks[1].firstDay).toBe("2026-11-29");
  });

  it("keeps an empty week between sessions so a gap is visible", () => {
    const model = buildScheduleModel(
      [at("2026-11-02T04:30:00Z"), at("2026-11-16T04:30:00Z")],
      "Asia/Kolkata",
      { sessionsPerWeek: 1 },
    );
    expect(model.weeks.map((w) => w.sessions.length)).toEqual([1, 0, 1]);
    expect(model.weeks[1].short).toBe(true);
  });

  it("flags two sessions on one local day and mixed lengths", () => {
    const model = buildScheduleModel(
      [
        at("2026-12-21T03:30:00Z", 90),
        at("2026-12-21T05:00:00Z", 90),
        at("2026-12-22T10:00:00Z", 60),
      ],
      "Asia/Kolkata",
    );
    expect(model.sessions.map((s) => s.sharesDay)).toEqual([true, true, false]);
    expect(model.mixedLengths).toBe(true);
  });

  it("returns an empty model for no sessions", () => {
    const model = buildScheduleModel([], "UTC");
    expect(model.weeks).toEqual([]);
    expect(model.multiWeek).toBe(false);
  });
});

describe("labels", () => {
  it("names a week range within and across months", () => {
    expect(weekRangeLabel("2026-11-16", "2026-11-22")).toBe("16–22 Nov");
    expect(weekRangeLabel("2026-11-28", "2026-12-04")).toBe("28 Nov – 4 Dec");
  });

  it("names the half of the day on both ends only when a range crosses noon", () => {
    const fmt = (d: Date, p: string) => formatInTimeZone(d, "Asia/Kolkata", p);
    expect(
      timeRangeLabel(
        fmt,
        new Date("2026-11-23T03:30:00Z"),
        new Date("2026-11-23T05:00:00Z"),
      ),
    ).toBe("9:00 – 10:30 AM");
    expect(
      timeRangeLabel(
        fmt,
        new Date("2026-11-23T06:00:00Z"),
        new Date("2026-11-23T07:00:00Z"),
      ),
    ).toBe("11:30 AM – 12:30 PM");
  });

  it("names a session length", () => {
    expect(lengthLabel(30)).toBe("30 min");
    expect(lengthLabel(60)).toBe("1 h");
    expect(lengthLabel(90)).toBe("1 h 30 min");
  });
});
