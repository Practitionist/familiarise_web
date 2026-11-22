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

describe("the Scheduled tab reads only standing sessions", () => {
  // A class whose Nov 18 session was cancelled, with its make-up on Nov 25.
  const nov18 = {
    gte: new Date("2026-11-18T00:00:00Z"),
    lte: new Date("2026-11-18T23:59:59Z"),
  };
  const now = new Date("2026-11-17T12:00:00Z");
  beforeEach(() => jest.useFakeTimers({ now, doNotFake: ["nextTick"] }));
  afterEach(() => jest.useRealTimers());

  const lapsedMove = (extra: object = {}) => ({
    rescheduleRequests: {
      some: {
        status: { in: ["PENDING_REVIEW"] },
        expiresAt: { lte: now },
        ...extra,
      },
    },
  });
  // Live, or released by a move whose deadline has passed (reads restore it).
  const standing = {
    OR: [
      {
        deletedAt: null,
        completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      },
      {
        isTentative: true,
        completionStatus: "RESCHEDULED",
        deletedAt: null,
        appointment: lapsedMove(),
      },
    ],
  };
  const standingNov18 = { startsAt: nov18, ...standing };
  type CountArgs = { where: { AND?: [{ occurrences?: { some: unknown } }] } };
  const countOccurrences = (call: number) =>
    (mockCount.mock.calls[call][0] as CountArgs).where.AND?.[0].occurrences
      ?.some;

  it("matches, shows and counts a range only by its standing sessions", async () => {
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
    expect(args.where.AND?.[0].occurrences?.some).toEqual(standingNov18);
    expect(args.select.occurrences.where).toEqual(standingNov18);
    // Calls: list total, All, Scheduled, Completed, Issue.
    expect(countOccurrences(2)).toEqual(standingNov18);
    expect(countOccurrences(3)).toEqual({ startsAt: nov18 });
    expect(countOccurrences(4)).toEqual({ startsAt: nov18 });
  });

  it("without a date range, lists, shows and counts only bookings with a standing session", async () => {
    await getStaffAppointments({ scope: { kind: "all" }, status: "scheduled" });
    const args = mockFindMany.mock.calls[0][0] as {
      where: CountArgs["where"];
      select: { occurrences: { where?: unknown } };
    };
    expect(args.where.AND?.[0].occurrences?.some).toEqual(standing);
    expect(args.select.occurrences.where).toEqual(standing);
    expect(countOccurrences(2)).toEqual(standing);
    expect(countOccurrences(3)).toBeUndefined();
  });

  it("lists and counts a consultation or plan a lapsed move left PENDING", async () => {
    await getStaffAppointments({ scope: { kind: "all" }, status: "scheduled" });
    const restoredToApproved = {
      AND: [
        {
          OR: [
            { consultationId: { not: null } },
            { subscriptionId: { not: null } },
          ],
        },
        lapsedMove({ originStatus: "APPROVED" }),
      ],
    };
    type StatusArgs = { where: { AND: [unknown, { OR: unknown[] }] } };
    const listStatus = (mockFindMany.mock.calls[0][0] as StatusArgs).where
      .AND[1].OR;
    const countStatus = (mockCount.mock.calls[2][0] as StatusArgs).where.AND[1]
      .OR;
    expect(listStatus).toContainEqual(restoredToApproved);
    expect(countStatus).toContainEqual(restoredToApproved);
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
