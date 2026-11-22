/**
 * @jest-environment node
 */

/**
 * GET /api/appointments/[appointmentId]/occurrences/[occurrenceId]/attendance
 * on a webinar: the plan's manager and a presenter read who attended; crew and
 * everyone else get the same 404 as a missing session.
 */

const mockAttendanceDb = {
  appointment: { findUnique: jest.fn() },
  appointmentOccurrence: { findFirst: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  consultantProfile: { findFirst: jest.fn() },
  collaborator: { findFirst: jest.fn() },
  membership: { findUnique: jest.fn(), count: jest.fn() },
};
const mockAttendanceAuth = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockAttendanceDb,
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockAttendanceAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));

import { rolesWithOrgPermission } from "../../lib/auth/org-permissions";

const PROFILES: Record<string, string> = {
  "host-user": "host-profile",
  "cohost-user": "cohost-profile",
  "crew-user": "crew-profile",
};
const TEAM: Record<string, { id: string; status: string; tier: string }> = {
  "cohost-profile": { id: "collab-1", status: "ACCEPTED", tier: "PRESENTER" },
  "crew-profile": { id: "collab-2", status: "ACCEPTED", tier: "CREW" },
};
const owner = (userId: string) => ({ consultantProfile: { userId } });

function seedWebinar(organizationId: string | null = null) {
  mockAttendanceDb.appointment.findUnique.mockResolvedValue({
    webinar: { webinarPlanId: "plan-1" },
    class: null,
  });
  mockAttendanceDb.webinarPlan.findUnique.mockResolvedValue({
    consultantProfileId: "host-profile",
    organizationId,
    archivedAt: null,
    organization: organizationId ? { status: "ACTIVE" } : null,
  });
  mockAttendanceDb.consultantProfile.findFirst.mockImplementation(
    async (args: { where: { userId: string } }) =>
      PROFILES[args.where.userId] ? { id: PROFILES[args.where.userId] } : null,
  );
  mockAttendanceDb.collaborator.findFirst.mockImplementation(
    async (args: { where: { consultantProfileId: string } }) =>
      TEAM[args.where.consultantProfileId] ?? null,
  );
  mockAttendanceDb.membership.count.mockResolvedValue(1);
  mockAttendanceDb.membership.findUnique.mockImplementation(
    async (args: { where: { userId_organizationId: { userId: string } } }) =>
      args.where.userId_organizationId.userId === "operator-user"
        ? {
            status: "ACTIVE",
            role: rolesWithOrgPermission("catalog.manage")[0],
          }
        : null,
  );
  mockAttendanceDb.appointmentOccurrence.findFirst.mockResolvedValue({
    startsAt: new Date("2026-11-01T10:00:00Z"),
    endsAt: new Date("2026-11-01T11:00:00Z"),
    presences: [],
    appointment: {
      consultation: null,
      subscription: null,
      trial: null,
      webinar: {
        webinarPlan: {
          ...owner("host-user"),
          collaborators: [owner("cohost-user"), owner("crew-user")],
        },
      },
      class: null,
      participants: [{ userId: "buyer-a", user: { name: "Asha" } }],
    },
  });
}

async function readAs(id: string) {
  mockAttendanceAuth.mockResolvedValue({
    session: { user: { id, role: "CONSULTANT" } },
  });
  const { GET } =
    await import("../../app/api/appointments/[appointmentId]/occurrences/[occurrenceId]/attendance/route");
  const res = await GET(new Request("http://x"), {
    params: Promise.resolve({ appointmentId: "appt-1", occurrenceId: "occ-1" }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { seats?: { userId: string }[] },
  };
}

beforeEach(() => jest.clearAllMocks());

describe("session attendance audience", () => {
  it.each(["host-user", "cohost-user"])(
    "%s reads who attended",
    async (userId) => {
      seedWebinar();
      const { status, body } = await readAs(userId);
      expect(status).toBe(200);
      expect(body.seats?.map((s) => s.userId)).toEqual(["buyer-a"]);
    },
  );

  it("an operator of the owning organisation reads who attended", async () => {
    seedWebinar("org-1");
    const { status, body } = await readAs("operator-user");
    expect(status).toBe(200);
    expect(body.seats).toHaveLength(1);
  });

  it.each(["crew-user", "stranger"])(
    "%s is answered like a missing session and the seats are never read",
    async (userId) => {
      seedWebinar();
      const { status, body } = await readAs(userId);
      expect(status).toBe(404);
      expect(body).not.toHaveProperty("seats");
      expect(
        mockAttendanceDb.appointmentOccurrence.findFirst,
      ).not.toHaveBeenCalled();
    },
  );
});
