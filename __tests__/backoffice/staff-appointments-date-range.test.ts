/**
 * @jest-environment node
 */

/** The operator Appointments date filter: both bounds survive, a bad bound is a 400. */

const mockCount = jest.fn(async (_args: unknown) => 0);
const mockFindMany = jest.fn(async (_args: unknown): Promise<unknown[]> => []);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findMany: (args: unknown) => mockFindMany(args),
      count: (args: unknown) => mockCount(args),
    },
    user: { findMany: async () => [] },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "STAFF" } },
  }),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/staff/appointments/route";
import { getStaffAppointments } from "../../lib/data/staff-appointments";

beforeEach(() => jest.clearAllMocks());

/** The `startsAt` filter the reader put on the occurrences relation. */
function startsAtFilter(): unknown {
  const args = mockFindMany.mock.calls[0][0] as {
    where: { occurrences?: { some: { startsAt: unknown } } };
  };
  return args.where.occurrences?.some.startsAt;
}

it("keeps both bounds in one startsAt filter", async () => {
  await getStaffAppointments({
    scope: { kind: "all" },
    dateFrom: "2026-11-01T00:00:00Z",
    dateTo: "2026-11-30T00:00:00Z",
  });
  expect(startsAtFilter()).toEqual({
    gte: new Date("2026-11-01T00:00:00Z"),
    lte: new Date("2026-11-30T00:00:00Z"),
  });
});

it("carries only gte when only dateFrom is given", async () => {
  await getStaffAppointments({
    scope: { kind: "all" },
    dateFrom: "2026-11-01T00:00:00Z",
  });
  expect(startsAtFilter()).toEqual({ gte: new Date("2026-11-01T00:00:00Z") });
});

it("answers 400 INVALID_QUERY for an unparseable bound without querying", async () => {
  const res = await GET(
    new NextRequest("http://localhost/api/staff/appointments?dateFrom=garbage"),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "INVALID_QUERY" });
  expect(mockFindMany).not.toHaveBeenCalled();
  expect(mockCount).not.toHaveBeenCalled();
});

it("treats an empty bound as absent, not as an invalid date", async () => {
  const res = await GET(
    new NextRequest("http://localhost/api/staff/appointments?dateFrom="),
  );
  expect(res.status).not.toBe(400);
  expect(mockFindMany).toHaveBeenCalled();
});

it("takes the displayed occurrence from inside the same range it filters on", async () => {
  await getStaffAppointments({
    scope: { kind: "all" },
    dateFrom: "2026-11-18T00:00:00Z",
    dateTo: "2026-11-18T23:59:59Z",
  });
  const args = mockFindMany.mock.calls[0][0] as {
    select: { occurrences: { where?: { startsAt: unknown }; take: number } };
  };
  expect(args.select.occurrences.take).toBe(1);
  expect(args.select.occurrences.where?.startsAt).toEqual(startsAtFilter());
});

describe("the Scheduled tab reads only live sessions", () => {
  // A class whose Nov 18 session was cancelled, with its make-up on Nov 25.
  const nov18 = {
    gte: new Date("2026-11-18T00:00:00Z"),
    lte: new Date("2026-11-18T23:59:59Z"),
  };
  const liveNov18 = {
    deletedAt: null,
    completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
    startsAt: nov18,
  };
  type CountArgs = { where: { AND?: [{ occurrences?: { some: unknown } }] } };
  const countOccurrences = (call: number) =>
    (mockCount.mock.calls[call][0] as CountArgs).where.AND?.[0].occurrences
      ?.some;

  it("matches, shows and counts a range only by its live sessions", async () => {
    await getStaffAppointments({
      scope: { kind: "all" },
      status: "scheduled",
      dateFrom: "2026-11-18T00:00:00Z",
      dateTo: "2026-11-18T23:59:59Z",
    });
    const args = mockFindMany.mock.calls[0][0] as {
      where: CountArgs["where"];
      select: { occurrences: { where?: unknown } };
    };
    expect(args.where.AND?.[0].occurrences?.some).toEqual(liveNov18);
    expect(args.select.occurrences.where).toEqual(liveNov18);
    // Calls: list total, All, Scheduled, Completed, Issue.
    expect(countOccurrences(2)).toEqual(liveNov18);
    expect(countOccurrences(3)).toEqual({ startsAt: nov18 });
    expect(countOccurrences(4)).toEqual({ startsAt: nov18 });
  });

  it("without a date range, lists, shows and counts only bookings with a live session", async () => {
    await getStaffAppointments({ scope: { kind: "all" }, status: "scheduled" });
    const live = {
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
    };
    const args = mockFindMany.mock.calls[0][0] as {
      where: CountArgs["where"];
      select: { occurrences: { where?: unknown } };
    };
    expect(args.where.AND?.[0].occurrences?.some).toEqual(live);
    expect(args.select.occurrences.where).toEqual(live);
    expect(countOccurrences(2)).toEqual(live);
    expect(countOccurrences(3)).toBeUndefined();
  });

  it("leaves the Issue tab's sessions unfiltered, so a cancelled booking still lists", async () => {
    await getStaffAppointments({
      scope: { kind: "all" },
      status: "issue",
      dateFrom: "2026-11-18T00:00:00Z",
      dateTo: "2026-11-18T23:59:59Z",
    });
    const args = mockFindMany.mock.calls[0][0] as {
      select: { occurrences: { where?: unknown } };
    };
    expect(args.select.occurrences.where).toEqual({ startsAt: nov18 });
  });
});
