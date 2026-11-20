/**
 * @jest-environment node
 */

/**
 * GET /api/scheduling/appointments/[appointmentId] on a webinar: what each
 * audience receives. Rows a caller may not read are never selected, so the
 * pins are on the keys of the answer and on the WHERE of the read. No read
 * selects email.
 */

import type { CollaboratorTier } from "@prisma/client";

const mockSeatScopeDb = {
  appointment: { findUnique: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  consultantProfile: { findFirst: jest.fn() },
  collaborator: { findFirst: jest.fn() },
  membership: { findUnique: jest.fn(), count: jest.fn() },
};
const mockSeatScopeAuth = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockSeatScopeDb,
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockSeatScopeAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));

type SeatWhere = { userId?: string; role?: { not?: string } } | undefined;

const SEATS = [
  { userId: "buyer-a", role: "CONSULTEE" },
  { userId: "buyer-b", role: "CONSULTEE" },
  // Written while this expert was on the team; the collaboration has ended.
  { userId: "former-user", role: "COLLABORATOR" },
];
const PROFILES: Record<string, string> = {
  "host-user": "host-profile",
  "cohost-user": "cohost-profile",
  "crew-user": "crew-profile",
  "former-user": "former-profile",
};
const TEAM: Record<
  string,
  { id: string; status: string; tier: CollaboratorTier }
> = {
  "cohost-profile": { id: "collab-1", status: "ACCEPTED", tier: "PRESENTER" },
  "crew-profile": { id: "collab-2", status: "ACCEPTED", tier: "CREW" },
};

const seats = (where: SeatWhere) =>
  SEATS.filter(
    (s) =>
      (!where?.userId || where.userId === s.userId) &&
      (!where?.role?.not || where.role.not !== s.role),
  );

function seedWebinar(organizationId: string | null = null) {
  mockSeatScopeDb.webinarPlan.findUnique.mockResolvedValue({
    consultantProfileId: "host-profile",
    organizationId,
    archivedAt: null,
    organization: organizationId ? { status: "ACTIVE" } : null,
  });
  mockSeatScopeDb.consultantProfile.findFirst.mockImplementation(
    async (args: { where: { userId: string } }) =>
      PROFILES[args.where.userId] ? { id: PROFILES[args.where.userId] } : null,
  );
  mockSeatScopeDb.collaborator.findFirst.mockImplementation(
    async (args: { where: { consultantProfileId: string } }) =>
      TEAM[args.where.consultantProfileId] ?? null,
  );
  // The named expert holds no active membership of the owning organisation.
  mockSeatScopeDb.membership.count.mockResolvedValue(0);
  mockSeatScopeDb.membership.findUnique.mockResolvedValue(null);
  mockSeatScopeDb.appointment.findUnique.mockImplementation(
    async (args: {
      select?: { participants: { where: SeatWhere } };
      include?: {
        payment?: { where?: SeatWhere };
        participants?: { where: SeatWhere };
      };
    }) => {
      if (args.select) {
        return {
          participants: seats(args.select.participants.where).map(() => ({
            id: "seat",
          })),
          consultation: null,
          subscription: null,
          webinar: { webinarPlanId: "plan-1" },
          class: null,
        };
      }
      const include = args.include ?? {};
      return {
        id: "appt-1",
        webinarId: "web-1",
        ...(include.payment && {
          payment: seats(include.payment.where)
            .filter((s) => s.role === "CONSULTEE")
            .map((s) => ({ userId: s.userId })),
        }),
        ...(include.participants && {
          participants: seats(include.participants.where),
        }),
      };
    },
  );
}

async function readAs(id: string, role = "CONSULTANT") {
  mockSeatScopeAuth.mockResolvedValue({
    session: { user: { id, role, consultantProfileId: PROFILES[id] } },
  });
  const { GET } =
    await import("../../app/api/scheduling/appointments/[appointmentId]/route");
  const res = await GET(new Request("http://x") as never, {
    params: Promise.resolve({ appointmentId: "appt-1" }),
  });
  const body = (await res.json()) as {
    data?: {
      payment?: { userId: string }[];
      participants?: { userId: string }[];
    };
  };
  return { status: res.status, data: body.data };
}

beforeEach(() => jest.clearAllMocks());

describe("appointment detail seat scope", () => {
  it("an attendee never receives another buyer's payment or seat", async () => {
    seedWebinar();
    const { status, data } = await readAs("buyer-a", "CONSULTEE");
    expect(status).toBe(200);
    expect(data?.payment?.map((p) => p.userId)).toEqual(["buyer-a"]);
    expect(data?.participants?.map((p) => p.userId)).toEqual(["buyer-a"]);
    const read = mockSeatScopeDb.appointment.findUnique.mock.calls[1][0];
    expect(read.include.payment.where).toEqual({ userId: "buyer-a" });
    expect(read.include.payment.select.user.select).not.toHaveProperty("email");
    expect(read.include.participants.include.user.select).not.toHaveProperty(
      "email",
    );
  });

  it("the plan's own expert reads every learner seat and every payment", async () => {
    seedWebinar();
    const { status, data } = await readAs("host-user");
    expect(status).toBe(200);
    expect(data?.payment?.map((p) => p.userId)).toEqual(["buyer-a", "buyer-b"]);
    expect(data?.participants?.map((p) => p.userId)).toEqual([
      "buyer-a",
      "buyer-b",
    ]);
  });

  it("a presenter reads the seats and no payment", async () => {
    seedWebinar();
    const { status, data } = await readAs("cohost-user");
    expect(status).toBe(200);
    expect(data?.participants?.map((p) => p.userId)).toEqual([
      "buyer-a",
      "buyer-b",
    ]);
    expect(data).not.toHaveProperty("payment");
  });

  it("crew reads neither the seats nor a payment", async () => {
    seedWebinar();
    const { status, data } = await readAs("crew-user");
    expect(status).toBe(200);
    expect(data).not.toHaveProperty("participants");
    expect(data).not.toHaveProperty("payment");
  });

  it("a former collaborator's old participant row opens nothing", async () => {
    seedWebinar();
    const { status } = await readAs("former-user");
    expect(status).toBe(403);
  });

  it("the named expert of an organisation's plan is refused once no longer its active expert", async () => {
    seedWebinar("org-1");
    const { status } = await readAs("host-user");
    expect(status).toBe(403);
  });

  it("a stranger is refused", async () => {
    seedWebinar();
    const { status } = await readAs("stranger", "CONSULTEE");
    expect(status).toBe(403);
  });
});
