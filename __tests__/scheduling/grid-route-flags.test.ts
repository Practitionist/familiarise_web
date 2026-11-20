/**
 * @jest-environment node
 */

/**
 * The availability grid route: a soft-deleted consultant publishes nothing
 * (and is never 304'd into a stale grid), cells inside the booking lead time
 * carry `tooSoon`, the subscription quota overlay is authorized, painted
 * and folded into the ETag, and only the host's own move frees the event's sessions.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    consultantProfile: { findUnique: jest.fn(), count: jest.fn() },
    appointment: { findMany: jest.fn() },
    membership: { findFirst: jest.fn() },
    subscription: { findFirst: jest.fn() },
    appointmentOccurrence: { aggregate: jest.fn(), findMany: jest.fn() },
    class: { findFirst: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => null),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/scheduling/availability-with-allocation/[consultantId]/route";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

const CONSULTANT_ID = "consultant-1";
const URL_BASE = `https://x.test/api/scheduling/availability-with-allocation/${CONSULTANT_ID}`;
const NOW = new Date("2026-09-07T09:50:00.000Z");
const HALF_HOUR = 30 * 60 * 1000;

const mockedMarker = prisma.$queryRaw as unknown as jest.Mock;
const mockedProfile = prisma.consultantProfile.findUnique as jest.Mock;
const mockedAppointments = prisma.appointment.findMany as jest.Mock;
const mockedSubscription = prisma.subscription.findFirst as jest.Mock;
const mockedMembership = prisma.membership.findFirst as jest.Mock;
const mockedOccurrenceStats = prisma.appointmentOccurrence
  .aggregate as jest.Mock;
const mockedOccurrences = prisma.appointmentOccurrence.findMany as jest.Mock;
const mockedSession = getSession as jest.Mock;

type Cell = {
  startsAt: string;
  endsAt: string;
  bookingStatus: string;
  tooSoon?: boolean;
  limitReached?: boolean;
};

function marker(overrides: Record<string, Date | number | null> = {}) {
  return [
    {
      profileUpdatedAt: new Date("2026-09-01T10:00:00.000Z"),
      consultantDeletedAt: null,
      availabilityUpdatedAt: new Date("2026-09-01T11:00:00.000Z"),
      availabilityRowCount: 1,
      paymentsUpdatedAt: null,
      slotsUpdatedAt: null,
      slotRowCount: 0,
      collaboratorsUpdatedAt: null,
      requestsUpdatedAt: null,
      nextHoldExpiry: null,
      ...overrides,
    },
  ];
}

function request(query: string, ifNoneMatch?: string) {
  return new NextRequest(`${URL_BASE}?${query}`, {
    headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : undefined,
  });
}

const DAY_QUERY =
  "startDateInUtc=2026-09-07T00:00:00.000Z&endDateInUtc=2026-09-08T00:00:00.000Z&timezone=UTC";
const params = Promise.resolve({ consultantId: CONSULTANT_ID });

const cellsOf = async (res: Response): Promise<Cell[]> => {
  const body = (await res.json()) as { data: Record<string, Cell[]> };
  return Object.values(body.data).flat();
};

beforeEach(() => {
  jest.clearAllMocks();
  // Only Date is faked: the request/response plumbing keeps real timers.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
  mockedMarker.mockResolvedValue(marker());
  mockedProfile.mockResolvedValue({
    id: CONSULTANT_ID,
    userId: "user-consultant",
    deletedAt: null,
    scheduleType: "CUSTOM",
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [
      {
        id: "custom-1",
        startsAt: new Date("2026-09-07T08:00:00.000Z"),
        endsAt: new Date("2026-09-07T12:00:00.000Z"),
      },
    ],
  });
  mockedAppointments.mockResolvedValue([]);
  mockedSession.mockResolvedValue(null);
  mockedMembership.mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("soft-deleted consultant", () => {
  it("answers 404 from the marker, even for a validator that matched before", async () => {
    const live = await GET(request(DAY_QUERY), { params });
    const etag = live.headers.get("ETag") as string;
    expect(live.status).toBe(200);

    mockedMarker.mockResolvedValue(
      marker({ consultantDeletedAt: new Date("2026-09-07T09:00:00.000Z") }),
    );
    const gone = await GET(request(DAY_QUERY, etag), { params });
    expect(gone.status).toBe(404);
    await expect(gone.json()).resolves.toEqual({
      error: "This expert is no longer taking bookings.",
      code: "CONSULTANT_NOT_FOUND",
    });
    expect(mockedProfile).toHaveBeenCalledTimes(1);
  });

  it("answers 404 when the profile row carries the tombstone", async () => {
    mockedProfile.mockResolvedValue({
      id: CONSULTANT_ID,
      userId: "user-consultant",
      deletedAt: new Date("2026-09-07T09:00:00.000Z"),
      scheduleType: "CUSTOM",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [],
    });
    const res = await GET(request(DAY_QUERY), { params });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: "CONSULTANT_NOT_FOUND",
    });
  });
});

describe("lead time", () => {
  it("flags cells that are not past but start inside 15 minutes", async () => {
    const cells = await cellsOf(await GET(request(DAY_QUERY), { params }));
    const flagged = cells
      .filter((c) => c.tooSoon)
      .map((c) => c.startsAt.slice(11, 16));
    // now = 09:50: 09:30 is running (end 10:00 > now), 10:00 starts before
    // 10:05; 09:00 is past, 10:30 is far enough out.
    expect(flagged).toEqual(["09:30", "10:00"]);
    expect(
      cells.find((c) => c.startsAt.endsWith("10:00:00.000Z")),
    ).toMatchObject({ bookingStatus: "available" });
  });

  it("does not 304 across a lead-time boundary", async () => {
    const first = await GET(request(DAY_QUERY), { params });
    const etag = first.headers.get("ETag") as string;
    jest.setSystemTime(new Date(NOW.getTime() + 60 * 1000));
    expect((await GET(request(DAY_QUERY, etag), { params })).status).toBe(304);
    // 10:16 + 15 min crosses 10:30, so the 10:30 cell enters the lead time.
    jest.setSystemTime(new Date(NOW.getTime() + 26 * 60 * 1000));
    const crossed = await GET(request(DAY_QUERY, etag), { params });
    expect(crossed.status).toBe(200);
    const flagged = (await cellsOf(crossed))
      .filter((c) => c.tooSoon)
      .map((c) => c.startsAt.slice(11, 16));
    expect(flagged).toEqual(["10:00", "10:30"]);
  });
});

describe("orphan cells", () => {
  it("paints an off-grid occurrence outside the windows atom by atom", async () => {
    mockedAppointments.mockResolvedValue([
      {
        id: "appt-1",
        consultation: { status: "SCHEDULED", bookingSource: "DIRECT_CHECKOUT" },
        subscription: null,
        payment: [],
        occurrences: [
          {
            id: "occ-1",
            startsAt: new Date("2026-09-07T13:17:00.000Z"),
            endsAt: new Date("2026-09-07T14:05:00.000Z"),
          },
        ],
      },
    ]);
    const cells = await cellsOf(await GET(request(DAY_QUERY), { params }));
    const busy = cells
      .filter((c) => c.bookingStatus === "fully-booked")
      .map((c) => [c.startsAt.slice(11, 16), c.endsAt.slice(11, 16)]);
    expect(busy).toEqual([
      ["13:00", "13:30"],
      ["13:30", "14:00"],
      ["14:00", "14:30"],
    ]);
  });
});

describe("quota overlay", () => {
  const SUB_QUERY = `startDateInUtc=2026-09-07T00:00:00.000Z&endDateInUtc=2026-09-14T00:00:00.000Z&timezone=UTC&subscriptionId=sub-1`;

  const occurrence = (
    startsAt: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `occ-${startsAt}`,
    startsAt: new Date(startsAt),
    endsAt: new Date(Date.parse(startsAt) + 2 * HALF_HOUR),
    completionStatus: "SCHEDULED",
    isTentative: false,
    deletedAt: null,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...extra,
  });

  /** The subscription row; its occurrences answer the aggregate and the 200-path read. */
  function subscription(occurrences: ReturnType<typeof occurrence>[]) {
    mockedOccurrenceStats.mockResolvedValue({
      _count: { _all: occurrences.length },
      _max: {
        updatedAt: occurrences.reduce<Date | null>(
          (max, o) => (!max || o.updatedAt > max ? o.updatedAt : max),
          null,
        ),
      },
    });
    mockedOccurrences.mockResolvedValue(occurrences);
    return {
      id: "sub-1",
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      sessionsTotal: 4,
      sessionsRefunded: 0,
      schedulingPeriodStartsAt: new Date("2026-09-07T00:00:00.000Z"),
      schedulingTimezone: "UTC",
      requestedBy: { userId: "user-consultee" },
      subscriptionPlan: {
        sessionsPerWeek: 1,
        durationInMonths: 1,
        totalSessions: 4,
      },
    };
  }

  beforeEach(() => {
    mockedProfile.mockResolvedValue({
      id: CONSULTANT_ID,
      userId: "user-consultant",
      deletedAt: null,
      scheduleType: "CUSTOM",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        {
          id: "custom-9",
          startsAt: new Date("2026-09-09T08:00:00.000Z"),
          endsAt: new Date("2026-09-09T12:00:00.000Z"),
        },
        {
          id: "custom-10",
          startsAt: new Date("2026-09-10T08:00:00.000Z"),
          endsAt: new Date("2026-09-10T12:00:00.000Z"),
        },
      ],
    });
  });

  it("refuses a caller who is not party to the plan", async () => {
    mockedSession.mockResolvedValue({ user: { id: "stranger", role: "USER" } });
    mockedSubscription.mockResolvedValue(subscription([]));
    const res = await GET(request(SUB_QUERY), { params });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "QUOTA_FORBIDDEN",
    });
    expect(mockedMarker).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller and a plan under another consultant", async () => {
    mockedSubscription.mockResolvedValue(subscription([]));
    expect((await GET(request(SUB_QUERY), { params })).status).toBe(403);
    mockedSession.mockResolvedValue({ user: { id: "user-consultee" } });
    mockedSubscription.mockResolvedValue(null);
    expect((await GET(request(SUB_QUERY), { params })).status).toBe(403);
    expect(mockedSubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "sub-1",
          deletedAt: null,
          subscriptionPlan: { consultantProfileId: CONSULTANT_ID },
        }),
      }),
    );
  });

  it("returns the quota and paints Limit reached except on the booking's own session", async () => {
    mockedSession.mockResolvedValue({ user: { id: "user-consultee" } });
    // One session a week, held on 9 Sep and in the next plan week too: this
    // week and the next (the one opened early) are both full.
    mockedSubscription.mockResolvedValue(
      subscription([
        occurrence("2026-09-09T10:00:00.000Z"),
        occurrence("2026-09-16T10:00:00.000Z"),
      ]),
    );
    const res = await GET(request(SUB_QUERY), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, Cell[]>;
      quota: Record<string, unknown>;
    };
    expect(body.quota).toMatchObject({
      unit: "week",
      capacity: 1,
      filled: 1,
      remainingThisCycle: 0,
      perDayCap: 1,
      fullDays: ["2026-09-09", "2026-09-16"],
      schedulingTimezone: "UTC",
    });
    const cells = Object.values(body.data).flat();
    const own = cells.filter(
      (c) =>
        c.startsAt === "2026-09-09T10:00:00.000Z" ||
        c.startsAt === "2026-09-09T10:30:00.000Z",
    );
    expect(own).toHaveLength(2);
    expect(own.every((c) => !c.limitReached)).toBe(true);
    const sameDay = cells.find(
      (c) => c.startsAt === "2026-09-09T08:00:00.000Z",
    );
    expect(sameDay?.limitReached).toBe(true);
    // 10 Sep is in this full week, before the open (next) week.
    const nextDay = cells.filter((c) => c.startsAt.startsWith("2026-09-10"));
    expect(nextDay.length).toBeGreaterThan(0);
    expect(nextDay.every((c) => c.limitReached)).toBe(true);
  });

  it("folds the subscription's occurrences into the ETag", async () => {
    mockedSession.mockResolvedValue({ user: { id: "user-consultee" } });
    mockedSubscription.mockResolvedValue(
      subscription([occurrence("2026-09-20T10:00:00.000Z")]),
    );
    const first = await GET(request(SUB_QUERY), { params });
    const etag = first.headers.get("ETag") as string;
    mockedOccurrences.mockClear();
    expect((await GET(request(SUB_QUERY, etag), { params })).status).toBe(304);
    // The 304 path reads an aggregate, never the occurrence list.
    expect(mockedOccurrences).not.toHaveBeenCalled();
    // An occurrence outside the window moved: the in-window marker is unchanged.
    mockedSubscription.mockResolvedValue(
      subscription([
        occurrence("2026-09-21T10:00:00.000Z", {
          updatedAt: new Date("2026-09-07T09:00:00.000Z"),
        }),
      ]),
    );
    expect((await GET(request(SUB_QUERY, etag), { params })).status).toBe(200);
  });

  it("counts the sessions a reschedule is releasing as free to re-pick", async () => {
    mockedSession.mockResolvedValue({ user: { id: "user-consultee" } });
    const held = occurrence("2026-09-09T10:00:00.000Z");
    mockedSubscription.mockResolvedValue(subscription([held]));
    const res = await GET(
      request(`${SUB_QUERY}&releasing=${encodeURIComponent(held.id)}`),
      { params },
    );
    const body = (await res.json()) as {
      data: Record<string, Cell[]>;
      quota: Record<string, unknown>;
    };
    expect(body.quota).toMatchObject({ remainingThisCycle: 1, fullDays: [] });
    const cells = Object.values(body.data).flat();
    expect(cells.some((c) => c.limitReached)).toBe(false);
  });

  it("omits the quota when none was asked for", async () => {
    const res = await GET(request(DAY_QUERY), { params });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("quota");
    expect(mockedSubscription).not.toHaveBeenCalled();
  });
});

describe("an event's own sessions on a move", () => {
  it("leaves the class's appointment out of host and co-host busy time for its host only", async () => {
    (prisma.class.findFirst as jest.Mock).mockResolvedValue({
      appointment: { id: "appt-class" },
      classPlan: {
        collaborators: [
          {
            consultantProfileId: "cohost-1",
            consultantProfile: { id: "cohost-1", userId: "user-cohost" },
          },
        ],
      },
    });
    const query = `${DAY_QUERY}&classId=class-1&purpose=reschedule`;
    const notMoving = { id: { not: "appt-class" } };
    const busyWheres = () =>
      mockedAppointments.mock.calls.map(
        ([args]: [{ where: { AND: unknown[] } }]) => args.where.AND,
      );

    mockedSession.mockResolvedValue({
      user: { id: "user-consultant", consultantProfileId: CONSULTANT_ID },
    });
    const own = await GET(request(query), { params });
    expect(own.status).toBe(200);
    expect(busyWheres()).toHaveLength(2);
    for (const and of busyWheres()) expect(and).toContainEqual(notMoving);

    mockedAppointments.mockClear();
    mockedSession.mockResolvedValue({
      user: { id: "user-other", consultantProfileId: "consultant-2" },
    });
    const other = await GET(request(query), { params });
    expect(other.status).toBe(200);
    for (const and of busyWheres()) expect(and).not.toContainEqual(notMoving);
    expect(other.headers.get("ETag")).not.toBe(own.headers.get("ETag"));
  });
});

describe("a co-host's published hours", () => {
  // The host publishes 08:00–12:00; the accepted co-host only 10:00–12:00.
  const query = `${DAY_QUERY}&classId=class-1`;
  type CoHostCell = Cell & {
    outsideCoHostHours?: boolean;
    outsideCoHostHoursOf?: string[];
  };

  beforeEach(() => {
    (prisma.class.findFirst as jest.Mock).mockResolvedValue({
      appointment: { id: "appt-class" },
      classPlan: {
        collaborators: [
          {
            consultantProfileId: "cohost-1",
            consultantProfile: {
              id: "cohost-1",
              userId: "user-cohost",
              scheduleType: "CUSTOM",
              availabilityWindowsWeekly: [],
              availabilityWindowsCustom: [
                {
                  id: "cohost-custom-1",
                  startsAt: new Date("2026-09-07T10:00:00.000Z"),
                  endsAt: new Date("2026-09-07T12:00:00.000Z"),
                },
              ],
              user: { id: "user-cohost", name: "Arjun Mehta" },
            },
          },
        ],
      },
    });
  });

  const startsOf = (cells: CoHostCell[]) =>
    cells.map((c) => c.startsAt.slice(11, 16));

  it("keeps the host's free cells and flags the ones the co-host has not published", async () => {
    const cells = (await cellsOf(
      await GET(request(query), { params }),
    )) as CoHostCell[];
    expect(startsOf(cells)).toEqual([
      "08:00",
      "08:30",
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    expect(cells.every((c) => c.bookingStatus === "available")).toBe(true);
    expect(startsOf(cells.filter((c) => c.outsideCoHostHours))).toEqual([
      "08:00",
      "08:30",
      "09:00",
      "09:30",
    ]);
  });

  it("names the co-host only for a viewer who already sees names", async () => {
    const anonymous = (await cellsOf(
      await GET(request(query), { params }),
    )) as CoHostCell[];
    expect(anonymous.some((c) => "outsideCoHostHoursOf" in c)).toBe(false);

    mockedSession.mockResolvedValue({
      user: { id: "user-consultant", consultantProfileId: CONSULTANT_ID },
    });
    const own = (await cellsOf(
      await GET(request(`${query}&includeAppointmentDetails=true`), {
        params,
      }),
    )) as CoHostCell[];
    expect(own.find((c) => c.startsAt.endsWith("08:00:00.000Z"))).toMatchObject(
      { outsideCoHostHours: true, outsideCoHostHoursOf: ["Arjun"] },
    );
    expect(
      own.find((c) => c.startsAt.endsWith("10:30:00.000Z")),
    ).not.toHaveProperty("outsideCoHostHours");
  });

  it("still blocks the co-host's actual commitments", async () => {
    mockedAppointments.mockImplementation(
      async ({ where }: { where: { AND: unknown[] } }) =>
        JSON.stringify(where).includes("cohost-1")
          ? [
              {
                id: "appt-cohost",
                consultation: {
                  status: "SCHEDULED",
                  bookingSource: "DIRECT_CHECKOUT",
                },
                subscription: null,
                payment: [],
                occurrences: [
                  {
                    id: "occ-cohost",
                    startsAt: new Date("2026-09-07T11:00:00.000Z"),
                    endsAt: new Date("2026-09-07T12:00:00.000Z"),
                  },
                ],
              },
            ]
          : [],
    );
    const cells = (await cellsOf(
      await GET(request(query), { params }),
    )) as CoHostCell[];
    expect(
      startsOf(cells.filter((c) => c.bookingStatus === "fully-booked")),
    ).toEqual(["11:00", "11:30"]);
  });
});

describe("a viewer zone that ends its day mid half-hour", () => {
  // Asia/Kathmandu (UTC+05:45): the week ends at local midnight, 18:15Z.
  const KATHMANDU_WEEK =
    "startDateInUtc=2026-11-21T18:15:00.000Z&endDateInUtc=2026-11-28T18:15:00.000Z&timezone=Asia/Kathmandu";

  beforeEach(() => {
    mockedProfile.mockResolvedValue({
      id: CONSULTANT_ID,
      userId: "user-consultant",
      deletedAt: null,
      scheduleType: "CUSTOM",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        {
          id: "custom-sat",
          startsAt: new Date("2026-11-28T14:00:00.000Z"),
          endsAt: new Date("2026-11-28T22:00:00.000Z"),
        },
      ],
    });
  });

  it("keeps the half-hour that starts before the window's end", async () => {
    const cells = await cellsOf(await GET(request(KATHMANDU_WEEK), { params }));
    expect(cells.at(-1)).toMatchObject({
      startsAt: "2026-11-28T18:00:00.000Z",
      endsAt: "2026-11-28T18:30:00.000Z",
      bookingStatus: "available",
    });
  });

  it("reads a session across that boundary as booked, not partly booked", async () => {
    mockedAppointments.mockResolvedValue([
      {
        id: "appt-1",
        consultation: { status: "SCHEDULED", bookingSource: "DIRECT_CHECKOUT" },
        subscription: null,
        payment: [],
        occurrences: [
          {
            id: "occ-1",
            startsAt: new Date("2026-11-28T18:00:00.000Z"),
            endsAt: new Date("2026-11-28T19:00:00.000Z"),
          },
        ],
      },
    ]);
    const cells = await cellsOf(await GET(request(KATHMANDU_WEEK), { params }));
    expect(cells.at(-1)).toMatchObject({
      startsAt: "2026-11-28T18:00:00.000Z",
      bookingStatus: "fully-booked",
    });
  });
});

describe("an expert buyer's own calendar", () => {
  const BUYER_QUERY = `${DAY_QUERY}&consulteeUserId=user-buyer&includeAppointmentDetails=true`;
  const hostRow = {
    id: CONSULTANT_ID,
    userId: "user-consultant",
    deletedAt: null,
    scheduleType: "CUSTOM",
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [
      {
        id: "custom-1",
        startsAt: new Date("2026-09-07T08:00:00.000Z"),
        endsAt: new Date("2026-09-07T12:00:00.000Z"),
      },
    ],
  };

  beforeEach(() => {
    mockedSession.mockResolvedValue({
      user: { id: "user-consultant", consultantProfileId: CONSULTANT_ID },
    });
    mockedProfile.mockImplementation(
      async ({ where }: { where: { id?: string; userId?: string } }) =>
        where.userId === "user-buyer" ? { id: "buyer-profile" } : hostRow,
    );
    // The buyer is an accepted co-host on someone else's webinar, 10:30–11:30.
    mockedAppointments.mockImplementation(
      async ({ where }: { where: unknown }) =>
        JSON.stringify(where).includes(
          '"collaborators":{"some":{"consultantProfileId":"buyer-profile","status":"ACCEPTED"}}',
        )
          ? [
              {
                id: "appt-cohosted",
                consultation: null,
                subscription: null,
                payment: [],
                occurrences: [
                  {
                    id: "occ-cohosted",
                    startsAt: new Date("2026-09-07T10:30:00.000Z"),
                    endsAt: new Date("2026-09-07T11:30:00.000Z"),
                  },
                ],
              },
            ]
          : [],
    );
  });

  it("paints the buyer's co-host commitment busy, with no detail", async () => {
    const res = await GET(request(BUYER_QUERY), { params });
    expect(res.status).toBe(200);
    const cells = (await cellsOf(res)) as (Cell & {
      overlappingAppointments?: unknown[];
    })[];
    const busy = cells.filter((c) => c.bookingStatus === "fully-booked");
    expect(busy.map((c) => c.startsAt.slice(11, 16))).toEqual([
      "10:30",
      "11:00",
    ]);
    for (const cell of busy) expect(cell.overlappingAppointments).toEqual([]);
  });

  it("reads a buyer with no expert profile by their seats alone", async () => {
    mockedProfile.mockImplementation(
      async ({ where }: { where: { id?: string; userId?: string } }) =>
        where.userId === "user-buyer" ? null : hostRow,
    );
    const res = await GET(request(BUYER_QUERY), { params });
    expect(res.status).toBe(200);
    const cells = await cellsOf(res);
    expect(cells.every((c) => c.bookingStatus === "available")).toBe(true);
    const consulteeWhere = JSON.stringify(
      mockedAppointments.mock.calls.map(([args]) => args.where),
    );
    expect(consulteeWhere).toContain('"userId":"user-buyer"');
    expect(consulteeWhere).not.toContain("buyer-profile");
  });
});

describe("a trial on the host's detail grid", () => {
  it('reads "Trial session" with the learner\'s name, for the host only', async () => {
    mockedAppointments.mockResolvedValue([
      {
        id: "appt-trial",
        appointmentType: "TRIAL",
        consultation: null,
        subscription: null,
        payment: [],
        trial: { consulteeProfile: { user: { name: "Charlotte Reid" } } },
        occurrences: [
          {
            id: "occ-trial",
            startsAt: new Date("2026-09-07T10:30:00.000Z"),
            endsAt: new Date("2026-09-07T11:00:00.000Z"),
          },
        ],
      },
    ]);
    mockedSession.mockResolvedValue({
      user: { id: "user-consultant", consultantProfileId: CONSULTANT_ID },
    });
    const own = (await cellsOf(
      await GET(request(`${DAY_QUERY}&includeAppointmentDetails=true`), {
        params,
      }),
    )) as (Cell & { overlappingAppointments?: unknown[] })[];
    expect(
      own.find((c) => c.startsAt.endsWith("10:30:00.000Z"))
        ?.overlappingAppointments,
    ).toEqual([
      {
        id: "appt-trial",
        type: "TRIAL",
        title: "Trial session",
        with: "Charlotte Reid",
      },
    ]);
    const detailQuery = mockedAppointments.mock.calls[0][0];
    expect(detailQuery.include.trial).toEqual({
      select: {
        consulteeProfile: { select: { user: { select: { name: true } } } },
      },
    });

    mockedAppointments.mockClear();
    mockedSession.mockResolvedValue(null);
    const anonymous = await cellsOf(await GET(request(DAY_QUERY), { params }));
    expect(anonymous.some((c) => "overlappingAppointments" in c)).toBe(false);
    for (const [args] of mockedAppointments.mock.calls) {
      expect(args.include).not.toHaveProperty("trial");
    }
  });
});

describe("the 90-day booking horizon", () => {
  // now is 7 Sep 09:50Z, so the horizon falls on 6 Dec at 09:50Z.
  const HORIZON_DAY =
    "startDateInUtc=2026-12-06T00:00:00.000Z&endDateInUtc=2026-12-07T00:00:00.000Z&timezone=UTC";
  type HorizonCell = Cell & { beyondHorizon?: boolean };

  beforeEach(() => {
    mockedProfile.mockResolvedValue({
      id: CONSULTANT_ID,
      userId: "user-consultant",
      deletedAt: null,
      scheduleType: "CUSTOM",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        {
          id: "custom-dec",
          startsAt: new Date("2026-12-06T08:00:00.000Z"),
          endsAt: new Date("2026-12-06T12:00:00.000Z"),
        },
      ],
    });
    (prisma.class.findFirst as jest.Mock).mockResolvedValue({
      appointment: { id: "appt-class" },
      classPlan: { collaborators: [] },
    });
  });

  const flagged = async (query: string) =>
    ((await cellsOf(await GET(request(query), { params }))) as HorizonCell[])
      .filter((c) => c.beyondHorizon)
      .map((c) => c.startsAt.slice(11, 16));

  it("flags a 1:1 cell that starts more than 90 days from now", async () => {
    const beyond = ["10:00", "10:30", "11:00", "11:30"];
    expect(await flagged(HORIZON_DAY)).toEqual(beyond);
    expect(await flagged(`${HORIZON_DAY}&purpose=request`)).toEqual(beyond);
    expect(await flagged(`${HORIZON_DAY}&purpose=allocate`)).toEqual(beyond);
  });

  it("leaves the flagged cells free underneath", async () => {
    const cells = (await cellsOf(
      await GET(request(HORIZON_DAY), { params }),
    )) as HorizonCell[];
    expect(cells.every((c) => c.bookingStatus === "available")).toBe(true);
  });

  it("binds a 1:1 that is being moved too", async () => {
    expect(
      (await flagged(`${HORIZON_DAY}&purpose=reschedule`)).length,
    ).toBeGreaterThan(0);
    expect(await flagged(`${HORIZON_DAY}&purpose=reschedule`)).toEqual(
      await flagged(HORIZON_DAY),
    );
  });

  it("does not apply to a class, a webinar or a subscription's plan weeks", async () => {
    expect(await flagged(`${HORIZON_DAY}&classId=class-1`)).toEqual([]);
    expect(
      await flagged(`${HORIZON_DAY}&classId=class-1&purpose=allocate`),
    ).toEqual([]);
  });

  it("does not 304 across the horizon, and leaves a nearer window's tag alone", async () => {
    const first = await GET(request(HORIZON_DAY), { params });
    const etag = first.headers.get("ETag") as string;
    // 10:00 + 90 days is reached at 10:00: the 10:00 cell opens.
    jest.setSystemTime(new Date("2026-09-07T10:01:00.000Z"));
    const crossed = await GET(request(HORIZON_DAY, etag), { params });
    expect(crossed.status).toBe(200);
    expect(
      ((await cellsOf(crossed)) as HorizonCell[])
        .filter((c) => c.beyondHorizon)
        .map((c) => c.startsAt.slice(11, 16)),
    ).toEqual(["10:30", "11:00", "11:30"]);

    // A window that ends inside the horizon: the same two instants share a
    // lead-time bucket, so nothing has changed for it.
    jest.setSystemTime(NOW);
    const near = await GET(request(DAY_QUERY), { params });
    jest.setSystemTime(new Date("2026-09-07T10:01:00.000Z"));
    expect(
      (
        await GET(request(DAY_QUERY, near.headers.get("ETag") as string), {
          params,
        })
      ).status,
    ).toBe(304);
  });
});
