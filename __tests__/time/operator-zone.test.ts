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
} from "../../lib/time/operator-zone";

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
