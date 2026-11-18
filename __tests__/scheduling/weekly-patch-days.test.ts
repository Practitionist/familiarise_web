/**
 * @jest-environment node
 */

/** A weekly PATCH may omit either day; a day it sends must be a real one, named per field. */

import { parsePatchDays } from "@/lib/scheduling/availability-contract";

describe("parsePatchDays", () => {
  it("passes real days through, typed", () => {
    expect(parsePatchDays("MONDAY", "TUESDAY")).toEqual({
      ok: true,
      startDay: "MONDAY",
      endDay: "TUESDAY",
    });
  });

  it.each([undefined, null, ""])("treats %p as omitted", (absent) => {
    expect(parsePatchDays(absent, absent)).toEqual({
      ok: true,
      startDay: undefined,
      endDay: undefined,
    });
  });

  it("names the start field", () => {
    expect(parsePatchDays("FUNDAY", "MONDAY")).toEqual({
      ok: false,
      error: "Invalid day of week for start time",
    });
  });

  it("names the end field", () => {
    expect(parsePatchDays("MONDAY", 3)).toEqual({
      ok: false,
      error: "Invalid day of week for end time",
    });
  });
});
