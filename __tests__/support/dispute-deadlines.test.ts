/**
 * @jest-environment node
 */

/**
 * The dispute clocks.
 *
 * The business-day arithmetic matters because a deadline that lands on a
 * Sunday is not a deadline anybody can meet, and the respondent is judged
 * against it.
 */

import {
  addBusinessDays,
  complaintDeadlines,
  respondentDueAt,
  respondentWindowPassed,
} from "../../lib/support/disputes/deadlines";

describe("the respondent's window", () => {
  it("skips the weekend", () => {
    // Friday 2026-10-16 12:00 IST. Three business days: Mon 19, Tue 20, Wed 21.
    const friday = new Date("2026-10-16T06:30:00.000Z");
    const due = respondentDueAt(friday);
    expect(due.toISOString()).toBe("2026-10-21T06:30:00.000Z");
  });

  it("skips a weekend that falls in the middle", () => {
    // Wednesday 2026-10-14 12:00 IST. Business days: Thu 15, Fri 16, Mon 19.
    const wednesday = new Date("2026-10-14T06:30:00.000Z");
    expect(addBusinessDays(wednesday, 3).toISOString()).toBe(
      "2026-10-19T06:30:00.000Z",
    );
  });

  it("keeps the time of day", () => {
    const late = new Date("2026-10-16T12:00:00.000Z");
    const due = addBusinessDays(late, 1);
    // The same clock time three business days later, not midnight.
    expect(due.getUTCHours()).toBe(12);
  });

  it("knows when the window has passed", () => {
    const due = new Date("2026-10-21T00:00:00.000Z");
    expect(respondentWindowPassed(due, new Date("2026-10-20T23:59:00.000Z"))).toBe(
      false,
    );
    expect(respondentWindowPassed(due, new Date("2026-10-21T00:00:01.000Z"))).toBe(
      true,
    );
    // A dispute with no deadline never "passes".
    expect(respondentWindowPassed(null, new Date("2030-01-01T00:00:00.000Z"))).toBe(
      false,
    );
  });
});

describe("the statutory clocks", () => {
  it("acknowledges a complaint within 48 hours and redresses it within a month", () => {
    const from = new Date("2026-10-19T00:00:00.000Z");
    const { ackDueAt, redressalDueAt } = complaintDeadlines(from);
    expect(ackDueAt.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(redressalDueAt.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });
});
