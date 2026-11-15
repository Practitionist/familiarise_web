/** @jest-environment node */
/**
 * Who may remove an attendee for conduct, through the roster's door. The plan
 * reader answers the shape its select asks for, with the collaborator filter
 * applied as Postgres would apply the WHERE.
 */

const mockSession = {
  current: {
    id: "",
    role: "CONSULTEE",
    consultantProfileId: null as string | null,
  },
};
const mockRemove = jest.fn();

jest.mock("@/lib/auth-helpers", () => ({
  ...jest.requireActual("@/lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: mockSession.current } }),
}));
jest.mock("@/lib/rate-limit", () => ({
  ...jest.requireActual("@/lib/rate-limit"),
  applyRateLimit: async () => null,
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
    membership: { findFirst: jest.fn(async () => null) },
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
  expect(mockRemove).toHaveBeenCalledWith({
    appointmentId: "appt-1",
    targetUserId: "learner-2",
    actorUserId: "caller",
    reason: "DISRUPTIVE",
    note: undefined,
  });
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
