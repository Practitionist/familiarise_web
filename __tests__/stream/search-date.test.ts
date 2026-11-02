/**
 * @jest-environment node
 *
 * A chat-search term names a calendar day in the VIEWER's zone, so "today" at
 * 01:30 in Kolkata is already the next UTC day, and a day in a DST zone is not
 * always 24 hours long.
 */
import { parseSearchDays } from "@/lib/stream/search-date";

const KOLKATA = "Asia/Kolkata";
// 15:30 on 30 Oct 2026 in Kolkata.
const NOW = new Date("2026-10-30T10:00:00Z");

const iso = (days: ReturnType<typeof parseSearchDays>) =>
  days.map((d) => [d.start.toISOString(), d.end.toISOString()]);

describe("parseSearchDays", () => {
  it("reads an ISO day as that local day", () => {
    expect(iso(parseSearchDays("2026-11-03", NOW, KOLKATA))).toEqual([
      ["2026-11-02T18:30:00.000Z", "2026-11-03T18:30:00.000Z"],
    ]);
  });

  it.each(["3 nov 2026", "nov 3 2026", "3rd November 2026", "Nov 3rd, 2026"])(
    "reads %p as 3 Nov 2026",
    (term) => {
      expect(iso(parseSearchDays(term, NOW, KOLKATA))).toEqual([
        ["2026-11-02T18:30:00.000Z", "2026-11-03T18:30:00.000Z"],
      ]);
    },
  );

  it("offers the day in the year before, this year and the year after when no year is typed", () => {
    const starts = parseSearchDays("3 nov", NOW, KOLKATA).map((d) =>
      d.start.toISOString(),
    );
    expect(starts).toEqual([
      "2025-11-02T18:30:00.000Z",
      "2026-11-02T18:30:00.000Z",
      "2027-11-02T18:30:00.000Z",
    ]);
  });

  it("resolves today, tomorrow and yesterday in the viewer's zone", () => {
    expect(iso(parseSearchDays("today", NOW, KOLKATA))).toEqual([
      ["2026-10-29T18:30:00.000Z", "2026-10-30T18:30:00.000Z"],
    ]);
    expect(iso(parseSearchDays("tomorrow", NOW, KOLKATA))).toEqual([
      ["2026-10-30T18:30:00.000Z", "2026-10-31T18:30:00.000Z"],
    ]);
    expect(iso(parseSearchDays("yesterday", NOW, KOLKATA))).toEqual([
      ["2026-10-28T18:30:00.000Z", "2026-10-29T18:30:00.000Z"],
    ]);
  });

  it("is already the next local day when UTC has not rolled over yet", () => {
    // 01:30 on 31 Oct in Kolkata, still 30 Oct in UTC.
    const lateUtc = new Date("2026-10-30T20:00:00Z");
    expect(iso(parseSearchDays("today", lateUtc, KOLKATA))).toEqual([
      ["2026-10-30T18:30:00.000Z", "2026-10-31T18:30:00.000Z"],
    ]);
  });

  it("measures a DST day by the clock, not as 24 hours", () => {
    const [day] = parseSearchDays("2026-03-08", NOW, "America/New_York");
    expect(day.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it.each([
    "",
    "karen",
    "may",
    "mar",
    "november",
    "3/11",
    "3 abc",
    "31 feb",
    "2026-02-30",
    "2026-13-01",
    "0 nov",
    "constructor",
    "__proto__",
    "3 constructor",
    "constructor 3",
  ])("does not treat %p as a date", (term) => {
    expect(parseSearchDays(term, NOW, KOLKATA)).toEqual([]);
  });

  it("accepts 29 Feb only in a leap year", () => {
    expect(parseSearchDays("29 feb 2027", NOW, KOLKATA)).toEqual([]);
    expect(parseSearchDays("29 feb 2028", NOW, KOLKATA)).toHaveLength(1);
  });
});
