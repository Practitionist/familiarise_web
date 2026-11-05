/** @jest-environment node */

import { NextRequest } from "next/server";
import {
  InvalidPeriodParamError,
  parseGstPeriodParam,
  parseTdsReturnParams,
} from "../../lib/cron/cleanup-route";
import { istMonthStart, nextMonthStart } from "../../lib/compliance/ist-period";

const req = (query: string) =>
  new NextRequest(`https://example.invalid/api/cleanup/job${query}`);

describe("parseGstPeriodParam", () => {
  it("is undefined when absent and the month when well formed", () => {
    expect(parseGstPeriodParam(req(""))).toBeUndefined();
    expect(parseGstPeriodParam(req("?period=2026-09"))).toBe("2026-09");
  });

  it.each(["2026-13", "2026-00", "2026-9", "2026-09-01", ""])(
    "rejects %j",
    (period) => {
      expect(() => parseGstPeriodParam(req(`?period=${period}`))).toThrow(
        InvalidPeriodParamError,
      );
    },
  );
});

describe("parseTdsReturnParams", () => {
  it("leaves both fields undefined when absent", () => {
    expect(parseTdsReturnParams(req(""))).toEqual({
      financialYear: undefined,
      quarter: undefined,
    });
  });

  it("parses the fiscal year and quarter independently", () => {
    expect(parseTdsReturnParams(req("?fy=2026-27&quarter=2"))).toEqual({
      financialYear: "2026-27",
      quarter: 2,
    });
    expect(parseTdsReturnParams(req("?quarter=4"))).toEqual({
      financialYear: undefined,
      quarter: 4,
    });
  });

  it("accepts consecutive years including the century rollover", () => {
    expect(parseTdsReturnParams(req("?fy=2026-27")).financialYear).toBe(
      "2026-27",
    );
    expect(parseTdsReturnParams(req("?fy=2099-00")).financialYear).toBe(
      "2099-00",
    );
  });

  it.each([
    "?fy=2026",
    "?fy=2026-99",
    "?quarter=0",
    "?quarter=5",
    "?quarter=1.5",
    "?quarter=x",
  ])("rejects %j", (query) => {
    expect(() => parseTdsReturnParams(req(query))).toThrow(
      InvalidPeriodParamError,
    );
  });
});

describe("istMonthStart", () => {
  it("is IST midnight of the first of the month", () => {
    expect(istMonthStart("2026-09").toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
    expect(nextMonthStart(istMonthStart("2026-12")).toISOString()).toBe(
      "2026-12-31T18:30:00.000Z",
    );
  });
});
