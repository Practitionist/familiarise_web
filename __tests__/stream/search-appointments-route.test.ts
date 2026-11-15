/**
 * @jest-environment node
 *
 * The chat search offers exactly the conversations `/api/stream/channels/open`
 * will accept, finds them by the OTHER party, plan title, email (consultants
 * only) or session date, and ranks before it caps.
 */
import { NextRequest } from "next/server";

let mockSession: { user: { id: string } } | null = { user: { id: "viewer" } };
const mockConsultations = jest.fn();
const mockSubscriptions = jest.fn();
const mockWebinars = jest.fn();
const mockClasses = jest.fn();

jest.mock("../../lib/auth-server", () => ({
  getSession: async () => mockSession,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: (...a: unknown[]) => mockConsultations(...a) },
    subscription: { findMany: (...a: unknown[]) => mockSubscriptions(...a) },
    webinar: { findMany: (...a: unknown[]) => mockWebinars(...a) },
    class: { findMany: (...a: unknown[]) => mockClasses(...a) },
  },
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  buildBookingOrgScopeWhere: () => undefined,
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { GET } from "../../app/api/stream/channels/search-appointments/route";
import { getDmChannelId } from "../../lib/stream-utils";

/** The trial and refunded-seat exclusions /open applies to every direct booking. */
const nonDmDirectBooking = {
  NOT: [
    { appointment: { is: { appointmentType: "TRIAL" } } },
    {
      appointment: {
        is: {
          participants: { some: { role: "CONSULTEE", status: "REFUNDED" } },
        },
      },
    },
  ],
};

type Person = { id: string; name: string | null; email?: string | null };

const person = ({ id, name, email = null }: Person) => ({
  id,
  name,
  email,
  image: null,
});

function consultation(opts: {
  id: string;
  title?: string;
  consultant: Person;
  consultee: Person;
  startsAt?: Date;
  createdAt?: Date;
}) {
  return {
    id: opts.id,
    createdAt: opts.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    consultationPlan: {
      title: opts.title ?? "Career plan",
      organizationId: null,
      consultantProfile: {
        id: `cp-${opts.consultant.id}`,
        user: person(opts.consultant),
      },
    },
    requestedBy: { user: person(opts.consultee) },
    appointment: {
      organizationId: null,
      occurrences: opts.startsAt ? [{ startsAt: opts.startsAt }] : [],
    },
  };
}

function event(opts: {
  id: string;
  title: string;
  host: Person | null;
  startsAt?: Date;
}) {
  return {
    id: opts.id,
    webinarPlan: {
      title: opts.title,
      consultantProfile: opts.host
        ? { id: "cp-host", user: person(opts.host) }
        : null,
    },
    classPlan: {
      title: opts.title,
      consultantProfile: opts.host
        ? { id: "cp-host", user: person(opts.host) }
        : null,
    },
    appointment: {
      occurrences: opts.startsAt ? [{ startsAt: opts.startsAt }] : [],
    },
  };
}

const VIEWER: Person = {
  id: "viewer",
  name: "Benjamin Brown",
  email: "ben@x.io",
};

async function search(params: Record<string, string>) {
  const url = new URL(
    "http://localhost/api/stream/channels/search-appointments",
  );
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await GET(new NextRequest(url));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  mockSession = { user: { id: "viewer" } };
  mockConsultations.mockResolvedValue([]);
  mockSubscriptions.mockResolvedValue([]);
  mockWebinars.mockResolvedValue([]);
  mockClasses.mockResolvedValue([]);
});

describe("access", () => {
  it("refuses a signed-out caller", async () => {
    mockSession = null;
    expect((await search({ q: "karen" })).status).toBe(401);
  });

  it("does not query for a term shorter than two characters", async () => {
    expect((await search({ q: "k" })).body).toEqual([]);
    expect((await search({ q: "  k " })).body).toEqual([]);
    expect(mockConsultations).not.toHaveBeenCalled();
  });

  it("does not query for a term longer than any plan title", async () => {
    expect((await search({ q: "a".repeat(201) })).body).toEqual([]);
    expect(mockConsultations).not.toHaveBeenCalled();

    expect((await search({ q: "a".repeat(200) })).status).toBe(200);
    expect(mockConsultations).toHaveBeenCalledTimes(1);
  });

  it("falls back to UTC for an oversized or unknown time zone instead of failing", async () => {
    const day = {
      startsAt: {
        gte: new Date("2026-11-03T00:00:00Z"),
        lt: new Date("2026-11-04T00:00:00Z"),
      },
    };
    for (const tz of ["x".repeat(200), "Not/AZone"]) {
      mockConsultations.mockClear();
      expect((await search({ q: "3 nov 2026", tz })).status).toBe(200);
      const where =
        mockConsultations.mock.calls[0][0].select.appointment.select.occurrences
          .where;
      expect(where.OR).toEqual([day]);
    }
  });

  it.each(["constructor", "__proto__"])(
    "treats %p as plain text, not a date",
    async (q) => {
      expect((await search({ q })).status).toBe(200);
      const where =
        mockConsultations.mock.calls[0][0].select.appointment.select.occurrences
          .where;
      expect(where.OR).toBeUndefined();
      expect(mockConsultations.mock.calls[0][0].where.AND[0].OR).toHaveLength(
        3,
      );
    },
  );
});

describe("what the query asks of the database", () => {
  it("excludes trial and refunded-seat bookings, which /open refuses", async () => {
    await search({ q: "karen" });
    expect(mockConsultations.mock.calls[0][0].where.AND).toContainEqual(
      nonDmDirectBooking,
    );
    expect(mockSubscriptions.mock.calls[0][0].where.AND).toContainEqual(
      nonDmDirectBooking,
    );
  });

  it("searches only the other party's name, never the caller's own", async () => {
    await search({ q: "karen" });
    const arms = mockConsultations.mock.calls[0][0].where.AND[0].OR;
    // Consultee caller: the consultant's name, guarded by "I am the requester".
    expect(arms).toContainEqual({
      requestedBy: { userId: "viewer" },
      consultationPlan: {
        consultantProfile: {
          user: { name: { contains: "karen", mode: "insensitive" } },
        },
      },
    });
    // Consultant caller: the consultee's name or email, guarded by "I am the host".
    expect(arms).toContainEqual({
      consultationPlan: { consultantProfile: { userId: "viewer" } },
      requestedBy: {
        user: {
          OR: [
            { name: { contains: "karen", mode: "insensitive" } },
            { email: { contains: "karen", mode: "insensitive" } },
          ],
        },
      },
    });
    // No bare name arm that would match the caller themselves.
    expect(arms).toHaveLength(3);
  });

  it("does not match a host's own name on their own events", async () => {
    await search({ q: "karen" });
    const arms = mockWebinars.mock.calls[0][0].where.AND[0].OR;
    expect(arms).toContainEqual({
      webinarPlan: {
        consultantProfile: {
          userId: { not: "viewer" },
          user: { name: { contains: "karen", mode: "insensitive" } },
        },
      },
    });
  });

  it("adds no date arm for an ordinary term and shows the next upcoming session", async () => {
    await search({ q: "karen" });
    const call = mockConsultations.mock.calls[0][0];
    expect(call.where.AND[0].OR).toHaveLength(3);
    const where = call.select.appointment.select.occurrences.where;
    expect(where.startsAt.gte).toBeInstanceOf(Date);
    expect(where.OR).toBeUndefined();
  });

  it("searches sessions on a named day in the viewer's zone", async () => {
    await search({ q: "3 nov 2026", tz: "Asia/Kolkata" });
    const day = {
      startsAt: {
        gte: new Date("2026-11-02T18:30:00Z"),
        lt: new Date("2026-11-03T18:30:00Z"),
      },
    };
    const call = mockConsultations.mock.calls[0][0];
    expect(call.where.AND[0].OR).toContainEqual({
      appointment: {
        occurrences: {
          some: {
            deletedAt: null,
            completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
            OR: [day],
          },
        },
      },
    });
    expect(call.select.appointment.select.occurrences.where.OR).toEqual([day]);
  });

  it("keeps every scoping arm on the events", async () => {
    await search({ q: "workshop" });
    const and = mockWebinars.mock.calls[0][0].where.AND;
    expect(and[1]).toEqual({
      status: { in: ["SCHEDULED", "COMPLETED"] },
    });
    expect(and[2].OR).toHaveLength(3);
  });
});

describe("the rows it returns", () => {
  it("labels a consultee's row with the consultant and points at the real channel", async () => {
    const consultant = {
      id: "karen",
      name: "Karen Anderson",
      email: "karen@x.io",
    };
    mockConsultations.mockResolvedValue([
      consultation({
        id: "c1",
        consultant,
        consultee: VIEWER,
        startsAt: new Date("2026-11-03T09:00:00Z"),
      }),
    ]);
    const { body } = await search({ q: "karen" });
    expect(body).toEqual([
      expect.objectContaining({
        id: "c1",
        type: "consultation",
        counterpartyUserId: "karen",
        counterpartyName: "Karen Anderson",
        channelId: getDmChannelId("karen", "viewer", null),
        startsAt: "2026-11-03T09:00:00.000Z",
      }),
    ]);
  });

  it("shows a consultant the consultee's email only when the email is what matched", async () => {
    const consultee = {
      id: "asha",
      name: "Asha Rao",
      email: "asha.rao@mail.io",
    };
    mockConsultations.mockResolvedValue([
      consultation({ id: "c1", consultant: VIEWER, consultee }),
    ]);

    const byEmail = (await search({ q: "mail.io" })).body;
    expect(byEmail[0].counterpartyEmail).toBe("asha.rao@mail.io");

    const byName = (await search({ q: "asha" })).body;
    expect(byName[0].counterpartyEmail).toBeUndefined();
  });

  it("never returns a consultant's email to a consultee", async () => {
    mockConsultations.mockResolvedValue([
      consultation({
        id: "c1",
        consultant: {
          id: "karen",
          name: "Karen Anderson",
          email: "karen@secret.io",
        },
        consultee: VIEWER,
      }),
    ]);
    const { body } = await search({ q: "secret.io" });
    expect(JSON.stringify(body)).not.toContain("karen@secret.io");
  });

  it("returns an event with its host and the event channel id", async () => {
    mockWebinars.mockResolvedValue([
      event({
        id: "w1",
        title: "Expert Workshop",
        host: { id: "h", name: "Hana Host" },
        startsAt: new Date("2026-12-01T05:00:00Z"),
      }),
    ]);
    mockClasses.mockResolvedValue([
      event({
        id: "k1",
        title: "Expert Class",
        host: { id: "h", name: "Hana Host" },
      }),
      event({ id: "k2", title: "Expert Orphan", host: null }),
    ]);
    const { body } = await search({ q: "expert" });
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "webinar",
          channelId: "webinar-w1",
          counterpartyName: "Hana Host",
          startsAt: "2026-12-01T05:00:00.000Z",
        }),
        expect.objectContaining({ type: "class", channelId: "class-k1" }),
      ]),
    );
    expect(body).toHaveLength(2);
  });

  it("skips a legacy self-booked row instead of failing the search", async () => {
    mockConsultations.mockResolvedValue([
      consultation({ id: "self", consultant: VIEWER, consultee: VIEWER }),
      consultation({
        id: "ok",
        consultant: { id: "karen", name: "Karen Anderson" },
        consultee: VIEWER,
      }),
    ]);
    const { status, body } = await search({ q: "karen" });
    expect(status).toBe(200);
    expect(body.map((r: { id: string }) => r.id)).toEqual(["ok"]);
  });
});

describe("ranking and the cap", () => {
  it("puts word-prefix matches ahead of mid-word ones", async () => {
    // Alphabetically Frank would come first; "ra" is the START of Rahul only.
    mockConsultations.mockResolvedValue([
      consultation({
        id: "f",
        consultant: { id: "frank", name: "Frank Lee" },
        consultee: VIEWER,
      }),
      consultation({
        id: "r",
        consultant: { id: "rahul", name: "Rahul Das" },
        consultee: VIEWER,
      }),
    ]);
    const { body } = await search({ q: "ra" });
    expect(body.map((r: { id: string }) => r.id)).toEqual(["r", "f"]);
  });

  it("ranks a date match as strongly as a name prefix", async () => {
    mockConsultations.mockResolvedValue([
      consultation({
        id: "a",
        consultant: { id: "a", name: "Aaron" },
        consultee: VIEWER,
      }),
      consultation({
        id: "z",
        consultant: { id: "z", name: "Zoya" },
        consultee: VIEWER,
        startsAt: new Date("2026-11-03T09:00:00Z"),
      }),
    ]);
    const { body } = await search({ q: "3 nov 2026", tz: "Asia/Kolkata" });
    expect(body.map((r: { id: string }) => r.id)).toEqual(["z", "a"]);
  });

  it("keeps at most three rows per conversation so one person cannot crowd out the rest", async () => {
    const karen = { id: "karen", name: "Karen Anderson" };
    mockConsultations.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) =>
        consultation({
          id: `k${i}`,
          title: `Plan ${i}`,
          consultant: karen,
          consultee: VIEWER,
        }),
      ),
      consultation({
        id: "liam",
        consultant: { id: "liam", name: "Liam Anderson" },
        consultee: VIEWER,
      }),
    ]);
    const { body } = await search({ q: "anderson" });
    const ids = body.map((r: { id: string }) => r.id);
    expect(ids.filter((id: string) => id.startsWith("k"))).toHaveLength(3);
    expect(ids).toContain("liam");
  });

  it("returns at most twenty conversations", async () => {
    mockConsultations.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        consultation({
          id: `c${i}`,
          consultant: {
            id: `p${i}`,
            name: `Person ${String(i).padStart(2, "0")}`,
          },
          consultee: VIEWER,
        }),
      ),
    );
    const { body } = await search({ q: "person" });
    expect(body).toHaveLength(20);
  });
});

describe("people mode (the New message picker)", () => {
  const person = (id: string, name: string) =>
    consultation({
      id,
      consultant: { id: `p-${id}`, name },
      consultee: VIEWER,
    });

  it("lists connections with no text, from bookings only and never events", async () => {
    mockConsultations.mockResolvedValue([
      person("z", "Zoya"),
      person("a", "Aaron"),
    ]);
    const { status, body } = await search({ mode: "people" });

    expect(status).toBe(200);
    expect(mockWebinars).not.toHaveBeenCalled();
    expect(mockClasses).not.toHaveBeenCalled();
    // Alphabetical, not match-ranked: there is nothing to rank by.
    expect(
      body.map((r: { counterpartyName: string }) => r.counterpartyName),
    ).toEqual(["Aaron", "Zoya"]);
  });

  it("adds no text arm without text, and reads more candidates than a search", async () => {
    await search({ mode: "people" });
    const call = mockConsultations.mock.calls[0][0];
    // status, trial exclusion, and the caller's own side: nothing else.
    expect(call.where.AND).toHaveLength(3);
    expect(call.take).toBe(100);
  });

  it("treats a one-character term as no text", async () => {
    await search({ mode: "people", q: "k" });
    expect(mockConsultations.mock.calls[0][0].where.AND).toHaveLength(3);
  });

  it("searches the same arms as the main box once there is text", async () => {
    await search({ mode: "people", q: "kar" });
    const and = mockConsultations.mock.calls[0][0].where.AND;
    expect(and).toHaveLength(4);
    expect(and[0].OR).toHaveLength(3);
    expect(mockWebinars).not.toHaveBeenCalled();
  });

  it("keeps the trial and refunded-seat exclusions", async () => {
    await search({ mode: "people" });
    expect(mockConsultations.mock.calls[0][0].where.AND).toContainEqual(
      nonDmDirectBooking,
    );
  });

  it("returns no email when nothing was typed", async () => {
    mockConsultations.mockResolvedValue([
      consultation({
        id: "c1",
        consultant: VIEWER,
        consultee: { id: "asha", name: null, email: "asha@mail.io" },
      }),
    ]);
    const { body } = await search({ mode: "people" });
    expect(body[0].counterpartyEmail).toBeUndefined();
  });

  it("returns at most fifty people", async () => {
    mockConsultations.mockResolvedValue(
      Array.from({ length: 70 }, (_, i) =>
        person(`c${i}`, `Person ${String(i).padStart(2, "0")}`),
      ),
    );
    expect((await search({ mode: "people" })).body).toHaveLength(50);
  });

  it("changes nothing for an ordinary search", async () => {
    expect((await search({ q: "k" })).body).toEqual([]);
    expect(mockConsultations).not.toHaveBeenCalled();
    await search({ q: "karen", mode: "bogus" });
    expect(mockWebinars).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest fifty connections, then lists them by name", async () => {
    // Person 00 is first alphabetically but the OLDEST booking; person 59 is the newest.
    mockConsultations.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) =>
        consultation({
          id: `c${i}`,
          consultant: {
            id: `p${i}`,
            name: `Person ${String(i).padStart(2, "0")}`,
          },
          consultee: VIEWER,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        }),
      ),
    );
    const { body } = await search({ mode: "people" });
    const names = body.map(
      (r: { counterpartyName: string }) => r.counterpartyName,
    );

    expect(names).toHaveLength(50);
    // The ten oldest (00 to 09) are the ones cut, not the ones late in the alphabet.
    expect(names[0]).toBe("Person 10");
    expect(names[49]).toBe("Person 59");
    expect(names).toEqual([...names].sort());
  });

  it("still ranks by match once text is typed", async () => {
    mockConsultations.mockResolvedValue([
      consultation({
        id: "old",
        consultant: { id: "a", name: "Rahul Das" },
        consultee: VIEWER,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      }),
      consultation({
        id: "new",
        consultant: { id: "b", name: "Frank Lee" },
        consultee: VIEWER,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      }),
    ]);
    const { body } = await search({ mode: "people", q: "ra" });
    // Rahul starts with "ra", Frank only contains it: rank, not recency, decides.
    expect(body.map((r: { id: string }) => r.id)).toEqual(["old", "new"]);
  });
});
