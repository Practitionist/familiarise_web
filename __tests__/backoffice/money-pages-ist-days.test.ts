/**
 * @jest-environment node
 */

/**
 * Money screens count days in India time, whatever zone the code runs in: the
 * TDS financial year and filing date, the payouts trend and the CSV filename,
 * and the incident window an operator types. Run under TZ=UTC and
 * TZ=America/Los_Angeles.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  }),
}));
jest.mock("../../lib/feature-flags", () => ({ ENABLE_TDS_ADMIN_VIEW: true }));

type Door = {
  run: (
    tx: unknown,
    ctx: { body: unknown; actor: unknown },
  ) => Promise<unknown>;
};
jest.mock("../../lib/backoffice/ops-action-log", () => {
  const doors: unknown[] = [];
  return {
    doors,
    withOpsAction: (...args: unknown[]) => {
      doors.push(args[3]);
      return jest.fn();
    },
  };
});

const mockPayouts = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: { findMany: (...a: unknown[]) => mockPayouts(...a) },
  },
}));

import { POST as tdsPost } from "../../app/api/admin/tds/route";
import { GET as trendGet } from "../../app/api/admin/payouts/trend/route";
import { getCurrentFY } from "../../app/dashboard/(backoffice)/[tree]/tds/TdsPageClient";
import { payoutCsvFilename } from "../../components/dashboard/backoffice/payouts/sections/PayoutListSection";
import { incidentWindowBody } from "../../components/dashboard/backoffice/money/IncidentsTab";
import { istDateKey, istFilingDate } from "../../lib/compliance/ist-period";

void tdsPost;
const mockDoors = jest.requireMock<{ doors: Door[] }>(
  "../../lib/backoffice/ops-action-log",
).doors;
/** 00:30 IST on 1 April 2026, which is still 31 March in UTC and Los Angeles. */
const EARLY_APRIL_FIRST = new Date("2026-03-31T19:00:00.000Z");

afterEach(() => jest.useRealTimers());

describe("TDS", () => {
  it.each([
    ["2026-03-31T18:29:00.000Z", "2025-26"],
    ["2026-03-31T18:30:00.000Z", "2026-27"],
    ["2026-04-01T00:00:00.000Z", "2026-27"],
  ])("at %s the default financial year is %s", (at, fy) => {
    jest.useFakeTimers().setSystemTime(new Date(at));
    expect(getCurrentFY()).toBe(fy);
  });

  it("defaults the filing date to today in India", () => {
    expect(istDateKey(EARLY_APRIL_FIRST)).toBe("2026-04-01");
  });

  it("records a filing dated today in India as 00:00 IST, in its first 5.5 hours", async () => {
    jest.useFakeTimers().setSystemTime(EARLY_APRIL_FIRST);
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 3 }));
    const tx = { tDSRecord: { count: async () => 3, updateMany } };
    await mockDoors[0].run(tx, {
      body: {
        financialYear: "2025-26",
        quarter: 4,
        filingDate: "2026-04-01",
        reportedInForm26Q: true,
        reason: "Filed the Q4 return on TRACES",
      },
      actor: { userId: "admin-1", role: "ADMIN" },
    });
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      data: {
        reportedInForm26Q: true,
        form26QFilingDate: new Date("2026-03-31T18:30:00.000Z"),
      },
    });
  });

  it("refuses a filing date after today in India, and a day that does not exist", () => {
    expect(istFilingDate("2026-04-02", EARLY_APRIL_FIRST)).toBeNull();
    expect(istFilingDate("2026-02-30", EARLY_APRIL_FIRST)).toBeNull();
    expect(istFilingDate("2026-04-01T00:00", EARLY_APRIL_FIRST)).toBeNull();
    expect(istFilingDate("2026-03-15", EARLY_APRIL_FIRST)?.toISOString()).toBe(
      "2026-03-14T18:30:00.000Z",
    );
  });
});

describe("payouts", () => {
  it("buckets the trend by India-time day", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-16T20:00:00.000Z"));
    mockPayouts.mockResolvedValue([
      // 01:30 IST on 17 November.
      { createdAt: new Date("2026-11-16T20:00:00.000Z"), amount: 50_000 },
      // 23:30 IST on 16 November.
      { createdAt: new Date("2026-11-16T18:00:00.000Z"), amount: 20_000 },
    ]);
    const { series } = (await (await trendGet()).json()) as {
      series: { day: string; label: string; totalPaise: number }[];
    };
    expect(series).toHaveLength(7);
    expect(series.at(-1)).toEqual({
      day: "2026-11-17",
      label: "17 Nov",
      totalPaise: 50_000,
    });
    expect(series.at(-2)).toMatchObject({
      day: "2026-11-16",
      totalPaise: 20_000,
    });
    expect(mockPayouts.mock.calls[0][0]).toMatchObject({
      where: { createdAt: { gte: new Date("2026-11-10T18:30:00.000Z") } },
    });
  });

  it("names the CSV by the India-time date", () => {
    expect(
      payoutCsvFilename("paid", new Date("2026-11-16T20:00:00.000Z")),
    ).toBe("payouts-paid-2026-11-17.csv");
  });
});

it("reads a typed incident window as India time", () => {
  expect(incidentWindowBody("2026-11-17T09:00", "2026-11-17T10:30")).toEqual({
    startsAt: "2026-11-17T03:30:00.000Z",
    endsAt: "2026-11-17T05:00:00.000Z",
  });
  expect(incidentWindowBody("2026-11-17T09:00", "")).toBeNull();
});
