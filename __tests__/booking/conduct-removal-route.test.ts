/** @jest-environment node */
/** Who may remove for conduct, through the roster door; the plan reader applies the collaborator WHERE as Postgres would. */

const mockSession = {
  current: {
    id: "",
    role: "CONSULTEE",
    consultantProfileId: null as string | null,
  },
};
const mockRemove = jest.fn();
const mockReport = jest.fn((..._args: unknown[]) => "event-1");

jest.mock("@/lib/auth-helpers", () => ({
  ...jest.requireActual("@/lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: mockSession.current } }),
}));
jest.mock("@/lib/rate-limit", () => ({
  ...jest.requireActual("@/lib/rate-limit"),
  applyRateLimit: async () => null,
}));
jest.mock("@/lib/observability/report", () => ({
  ...jest.requireActual("@/lib/observability/report"),
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("@/lib/booking/conduct-removal", () => ({
  removeAttendeeForConduct: (...args: unknown[]) => mockRemove(...args),
}));

type CollaboratorRow = {
  consultantProfileId: string;
  status: string;
  tier: string;
};
const mockPlan = {
  consultantProfileId: "profile-host",
  organizationId: null as string | null,
  /** How many active expert memberships the host holds in the owning organisation. */
  activeExpertMemberships: 0,
  collaborators: [
    {
      consultantProfileId: "profile-cohost",
      status: "ACCEPTED",
      tier: "PRESENTER",
    },
    { consultantProfileId: "profile-crew", status: "ACCEPTED", tier: "CREW" },
  ] as CollaboratorRow[],
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findFirst: jest.fn(
        async (args: {
          where: { webinarId?: string; id?: string };
          select: {
            webinar?: {
              select: {
                webinarPlan: {
                  select: {
                    collaborators: { where: CollaboratorRow };
                  };
                };
              };
            };
          };
        }) => {
          if (args.where.webinarId) return { id: "appt-1" };
          const want =
            args.select.webinar?.select.webinarPlan.select.collaborators.where;
          if (!want) return null;
          return {
            webinar: {
              webinarPlan: {
                consultantProfileId: mockPlan.consultantProfileId,
                organizationId: mockPlan.organizationId,
                collaborators: mockPlan.collaborators
                  .filter(
                    (c) =>
                      c.consultantProfileId === want.consultantProfileId &&
                      c.status === want.status &&
                      c.tier === want.tier,
                  )
                  .map((c) => ({ id: c.consultantProfileId })),
              },
            },
            class: null,
          };
        },
      ),
    },
    membership: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => mockPlan.activeExpertMemberships),
    },
  },
}));

import { handleGroupConductRemoval } from "@/lib/api/participants/group-participants-route";

const body = { targetUserId: "learner-2", reason: "DISRUPTIVE" };
const post = () =>
  handleGroupConductRemoval(
    new Request("http://test/api/participants/webinar/w1/remove", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    "webinar",
    "w1",
  );

beforeEach(() => {
  mockRemove.mockReset();
  mockRemove.mockResolvedValue({
    caseId: "case-1",
    caseReference: "SR-1",
    earningsHeld: true,
  });
});

it.each([
  ["the host", "CONSULTANT", "profile-host"],
  ["an accepted co-host", "CONSULTANT", "profile-cohost"],
  ["staff", "STAFF", null],
])("%s may remove", async (_who, role, profileId) => {
  mockSession.current = { id: "caller", role, consultantProfileId: profileId };
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    removed: true,
    caseReference: "SR-1",
    earningsHeld: true,
  });
  expect(mockRemove).toHaveBeenCalledWith(
    expect.objectContaining({
      appointmentId: "appt-1",
      targetUserId: "learner-2",
      actorUserId: "caller",
      reason: "DISRUPTIVE",
      note: undefined,
      authorizeTx: expect.any(Function),
    }),
  );
});

it.each([
  ["a crew collaborator", "CONSULTANT", "profile-crew"],
  ["another attendee", "CONSULTEE", null],
])("%s may not remove", async (_who, role, profileId) => {
  mockSession.current = { id: "caller", role, consultantProfileId: profileId };
  const response = await post();
  expect(response.status).toBe(403);
  expect(mockRemove).not.toHaveBeenCalled();
});

it("on an organisation's plan the host may remove only while an active expert of that organisation", async () => {
  mockSession.current = {
    id: "caller",
    role: "CONSULTANT",
    consultantProfileId: "profile-host",
  };
  mockPlan.organizationId = "org-1";
  try {
    mockPlan.activeExpertMemberships = 1;
    expect((await post()).status).toBe(200);
    const { membership } = jest.requireMock("@/lib/prisma").default as {
      membership: { count: jest.Mock };
    };
    expect(membership.count).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        consultantProfileId: "profile-host",
        status: "ACTIVE",
        role: "EXPERT",
      },
    });

    mockRemove.mockClear();
    mockPlan.activeExpertMemberships = 0;
    expect((await post()).status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  } finally {
    mockPlan.organizationId = null;
  }
});

it.each([["%20"], ["x".repeat(65)]])(
  "refuses a malformed event id %#",
  async (eventId) => {
    mockSession.current = {
      id: "caller",
      role: "CONSULTANT",
      consultantProfileId: "profile-host",
    };
    const prisma = jest.requireMock("@/lib/prisma").default as {
      appointment: { findFirst: jest.Mock };
    };
    prisma.appointment.findFirst.mockClear();
    const response = await handleGroupConductRemoval(
      new Request("http://test/remove", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      "webinar",
      decodeURIComponent(eventId),
    );
    expect(response.status).toBe(400);
    expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
  },
);

it("answers a bad body with a plain sentence, never the schema's internals", async () => {
  mockSession.current = {
    id: "caller",
    role: "CONSULTANT",
    consultantProfileId: "profile-host",
  };
  const response = await handleGroupConductRemoval(
    new Request("http://test/remove", {
      method: "POST",
      body: JSON.stringify({ targetUserId: "learner-2", reason: "OTHER" }),
    }),
    "webinar",
    "w1",
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Choose a reason, and say why when the reason is Other.",
  });
});

it("reports an unexpected failure to Sentry once, through the reporter that flushes before the function freezes", async () => {
  mockSession.current = {
    id: "caller",
    role: "CONSULTANT",
    consultantProfileId: "profile-host",
  };
  const fault = new Error("connection reset");
  mockRemove.mockRejectedValue(fault);
  const response = await post();
  expect(response.status).toBe(500);
  expect(mockReport).toHaveBeenCalledTimes(1);
  expect(mockReport).toHaveBeenCalledWith(
    fault,
    expect.objectContaining({ subsystem: "bookings", op: "conduct-removal" }),
  );
});
