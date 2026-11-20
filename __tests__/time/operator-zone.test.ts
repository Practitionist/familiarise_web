/** @jest-environment node */

/**
 * Operator screens print India time from the instant alone: the text is the
 * same whatever zone the server or the browser runs in. The expectations hold
 * unchanged under `TZ=UTC` and `TZ=Asia/Kolkata`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OperatorTime } from "../../lib/time/operator-time";
import {
  formatOperatorInstant,
  formatUtcInstant,
  operatorMonthStart,
  operatorPeriodStarts,
  operatorEndKind,
  fromOperatorWallTime,
  toOperatorWallTime,
} from "../../lib/time/operator-zone";
import { formatInvoiceDate } from "../../lib/time/invoice-date";

// 00:00 IST on 1 Apr 2026 is 18:30 UTC the day before.
const IST_MIDNIGHT = "2026-03-31T18:30:00.000Z";
// 00:00 UTC on 1 Apr 2026 is 05:30 IST the same day.
const UTC_MIDNIGHT = "2026-04-01T00:00:00.000Z";
// One minute before UTC midnight: still 31 Mar in UTC, already 1 Apr in IST.
const BEFORE_UTC_MIDNIGHT = "2026-03-31T23:59:00.000Z";

describe("operator time", () => {
  it("reads 00:00 IST as the new day", () => {
    expect(formatOperatorInstant(IST_MIDNIGHT, "date")).toBe("1 Apr 2026");
    expect(formatOperatorInstant(IST_MIDNIGHT, "time")).toBe("12:00 am IST");
    expect(formatOperatorInstant(IST_MIDNIGHT)).toBe(
      "1 Apr 2026, 12:00 am IST",
    );
    expect(formatUtcInstant(IST_MIDNIGHT)).toBe("31 Mar 2026, 6:30 pm UTC");
  });

  it("reads UTC midnight as 05:30 IST", () => {
    expect(formatOperatorInstant(UTC_MIDNIGHT)).toBe("1 Apr 2026, 5:30 am IST");
    expect(formatUtcInstant(UTC_MIDNIGHT)).toBe("1 Apr 2026, 12:00 am UTC");
  });

  it("dates the last UTC minute of a day by its India date", () => {
    expect(formatOperatorInstant(BEFORE_UTC_MIDNIGHT, "date")).toBe(
      "1 Apr 2026",
    );
  });

  it("prints three-letter months, September included, on invoices too", () => {
    // 08:30 UTC on 24 Sep 2026 is 2:00 pm IST.
    const sep = "2026-09-24T08:30:00.000Z";
    expect(formatOperatorInstant(sep, "date")).toBe("24 Sep 2026");
    expect(formatOperatorInstant(sep)).toBe("24 Sep 2026, 2:00 pm IST");
    expect(formatUtcInstant(sep)).toBe("24 Sep 2026, 8:30 am UTC");
    expect(formatInvoiceDate(sep)).toBe("24 Sep 2026");
    expect(formatInvoiceDate("2026-10-20T06:00:00.000Z")).toBe("20 Oct 2026");
  });

  it("answers a dash for no instant", () => {
    expect(formatOperatorInstant("not a date")).toBe("—");
  });

  it("starts the month at 00:00 IST", () => {
    expect(operatorMonthStart(new Date(IST_MIDNIGHT)).toISOString()).toBe(
      IST_MIDNIGHT,
    );
    // One second before 00:00 IST on 1 Apr is still March in India.
    expect(
      operatorMonthStart(new Date("2026-03-31T18:29:59.000Z")).toISOString(),
    ).toBe("2026-02-28T18:30:00.000Z");
    // 31 Mar 23:59 UTC is 1 Apr in India: April's start, not March's.
    expect(
      operatorMonthStart(new Date(BEFORE_UTC_MIDNIGHT)).toISOString(),
    ).toBe(IST_MIDNIGHT);
  });

  it("starts the day at 00:00 IST and the week on the IST Sunday", () => {
    const iso = (now: string) => {
      const p = operatorPeriodStarts(new Date(now));
      return {
        day: p.day.toISOString(),
        week: p.week.toISOString(),
        month: p.month.toISOString(),
      };
    };
    // Sun 12 Apr 2026, 00:00 IST: the week opens today.
    expect(iso("2026-04-11T18:30:00.000Z")).toEqual({
      day: "2026-04-11T18:30:00.000Z",
      week: "2026-04-11T18:30:00.000Z",
      month: "2026-03-31T18:30:00.000Z",
    });
    // Sat 11 Apr 2026, 23:59 IST: still the week that opened Sun 5 Apr.
    expect(iso("2026-04-11T18:29:00.000Z")).toEqual({
      day: "2026-04-10T18:30:00.000Z",
      week: "2026-04-04T18:30:00.000Z",
      month: "2026-03-31T18:30:00.000Z",
    });
    // Thu 2 Apr 2026, 05:30 IST (UTC midnight): the week crosses the month.
    expect(iso("2026-04-02T00:00:00.000Z")).toEqual({
      day: "2026-04-01T18:30:00.000Z",
      week: "2026-03-28T18:30:00.000Z",
      month: "2026-03-31T18:30:00.000Z",
    });
  });

  it("reads and fills datetime-local inputs as IST wall time", () => {
    expect(fromOperatorWallTime("2026-04-01T05:30")?.toISOString()).toBe(
      UTC_MIDNIGHT,
    );
    expect(fromOperatorWallTime("2026-04-01T00:00")?.toISOString()).toBe(
      IST_MIDNIGHT,
    );
    expect(toOperatorWallTime(UTC_MIDNIGHT)).toBe("2026-04-01T05:30");
    expect(toOperatorWallTime(IST_MIDNIGHT)).toBe("2026-04-01T00:00");
    // A round trip lands on the same instant.
    expect(
      fromOperatorWallTime(
        toOperatorWallTime(BEFORE_UTC_MIDNIGHT),
      )?.toISOString(),
    ).toBe(BEFORE_UTC_MIDNIGHT);
    expect(fromOperatorWallTime("")).toBeNull();
    expect(fromOperatorWallTime("2026-04-01")).toBeNull();
    expect(toOperatorWallTime(null)).toBe("");
  });

  it("prints a range's end date only when it is another IST day", () => {
    // 16 Nov 23:30 IST to 17 Nov 06:30 IST.
    expect(
      operatorEndKind("2026-11-16T18:00:00.000Z", "2026-11-17T01:00:00.000Z"),
    ).toBe("dateTime");
    // 09:00 to 10:00 IST on one day.
    expect(
      operatorEndKind("2026-11-16T03:30:00.000Z", "2026-11-16T04:30:00.000Z"),
    ).toBe("time");
  });

  it.each([
    // America/Los_Angeles skips 02:00–03:00 on 8 Mar 2026 and repeats 01:00–02:00 on 1 Nov.
    [
      "a Los Angeles spring gap",
      "2026-03-07T21:00:00.000Z",
      "2026-03-08T02:30",
    ],
    [
      "a Los Angeles autumn overlap",
      "2026-10-31T20:00:00.000Z",
      "2026-11-01T01:30",
    ],
    // Europe/London skips 01:00–02:00 on 29 Mar 2026 and repeats it on 25 Oct.
    ["a London spring gap", "2026-03-28T20:00:00.000Z", "2026-03-29T01:30"],
    ["a London autumn overlap", "2026-10-24T20:00:00.000Z", "2026-10-25T01:30"],
  ])(
    "round-trips an IST wall time that falls in %s of the host zone",
    (_case, iso, wall) => {
      expect(toOperatorWallTime(iso)).toBe(wall);
      expect(fromOperatorWallTime(wall)?.toISOString()).toBe(iso);
    },
  );

  it("cuts the day, week and month in IST inside a host DST gap", () => {
    // Sun 8 Mar 2026, 02:30 IST: the hour Los Angeles skips.
    const p = operatorPeriodStarts(new Date("2026-03-07T21:00:00.000Z"));
    expect(p.day.toISOString()).toBe("2026-03-07T18:30:00.000Z");
    expect(p.week.toISOString()).toBe("2026-03-07T18:30:00.000Z");
    expect(p.month.toISOString()).toBe("2026-02-28T18:30:00.000Z");
  });

  it("refuses a wall time whose fields are out of range", () => {
    expect(fromOperatorWallTime("2026-02-30T10:00")).toBeNull();
    expect(fromOperatorWallTime("2026-04-01T24:00")).toBeNull();
    expect(fromOperatorWallTime("2026-04-01T10:00:00")?.toISOString()).toBe(
      "2026-04-01T04:30:00.000Z",
    );
  });

  it("renders a <time> with the instant and its UTC reading", () => {
    expect(
      renderToStaticMarkup(
        createElement(OperatorTime, { value: UTC_MIDNIGHT }),
      ),
    ).toBe(
      `<time dateTime="${UTC_MIDNIGHT}" title="1 Apr 2026, 12:00 am UTC">1 Apr 2026, 5:30 am IST</time>`,
    );
    expect(
      renderToStaticMarkup(createElement(OperatorTime, { value: null })),
    ).toBe("—");
  });
});
