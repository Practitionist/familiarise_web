/**
 * @jest-environment node
 */

/**
 * GET /api/participants/webinar/[webinarId]: the plan's own expert reads the
 * roster with what each seat paid, a presenter reads the roster alone, and
 * crew get the 404 of a missing event.
 */

const mockRosterDb = {
  webinar: { findFirst: jest.fn() },
  payment: { findMany: jest.fn() },
  appointmentWaitlist: { count: jest.fn(async () => 0) },
  webinarPlan: { findUnique: jest.fn() },
  consultantProfile: { findFirst: jest.fn() },
  collaborator: { findFirst: jest.fn() },
  membership: { findUnique: jest.fn(), count: jest.fn() },
};
const mockRosterAuth = jest.fn();

jest.mock("@/lib/booking/event-waitlist", () => ({
  stageSeatOpenedNotices: jest.fn(),
  finishSeatOpenedNotices: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockRosterDb,
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockRosterAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  participantReadLimiter: {},
}));
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  __esModule: true,
  refundRemovedAttendeeSeat: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  removeUserFromEventChannel: jest.fn(),
}));

const PROFILES: Record<string, string> = {
  "host-user": "host-profile",
  "cohost-user": "cohost-profile",
  "crew-user": "crew-profile",
};
const TEAM: Record<string, { id: string; status: string; tier: string }> = {
  "cohost-profile": { id: "collab-1", status: "ACCEPTED", tier: "PRESENTER" },
  "crew-profile": { id: "collab-2", status: "ACCEPTED", tier: "CREW" },
};

type PlanArm = {
  consultantProfileId?: string;
  collaborators?: { some: { consultantProfileId: string; tier: string } };
};

/** The route's own plan gate, answered for this plan's owner and team. */
const admits = (arm: PlanArm) =>
  arm.consultantProfileId === "host-profile" ||
  (arm.collaborators !== undefined &&
    TEAM[arm.collaborators.some.consultantProfileId]?.tier ===
      arm.collaborators.some.tier);

function seedWebinar() {
  mockRosterDb.webinar.findFirst.mockImplementation(
    async (args: { where: { webinarPlan: { OR: PlanArm[] } } }) =>
      args.where.webinarPlan.OR.some(admits)
        ? {
            id: "web-1",
            webinarPlanId: "plan-1",
            webinarPlan: { id: "plan-1", collaborators: [] },
            appointment: {
              id: "appt-1",
              participants: [
                {
                  status: "CONFIRMED",
                  role: "CONSULTEE",
                  user: {
                    id: "buyer-a",
                    name: "Asha",
                    email: "a@x",
                    image: null,
                  },
                },
              ],
            },
          }
        : null,
  );
  mockRosterDb.payment.findMany.mockResolvedValue([
    {
      userId: "buyer-a",
      paymentStatus: "SUCCEEDED",
      amount: BigInt(50000),
      currency: "INR",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      refunds: [],
    },
  ]);
  mockRosterDb.webinarPlan.findUnique.mockResolvedValue({
    consultantProfileId: "host-profile",
    organizationId: null,
    archivedAt: null,
    organization: null,
  });
  mockRosterDb.consultantProfile.findFirst.mockImplementation(
    async (args: { where: { userId: string } }) =>
      PROFILES[args.where.userId] ? { id: PROFILES[args.where.userId] } : null,
  );
  mockRosterDb.collaborator.findFirst.mockImplementation(
    async (args: { where: { consultantProfileId: string } }) =>
      TEAM[args.where.consultantProfileId] ?? null,
  );
}

async function readAs(id: string) {
  mockRosterAuth.mockResolvedValue({
    session: {
      user: { id, role: "CONSULTANT", consultantProfileId: PROFILES[id] },
    },
  });
  const { GET } =
    await import("../../app/api/participants/webinar/[webinarId]/route");
  const res = await GET(new Request("http://x"), {
    params: Promise.resolve({ webinarId: "web-1" }),
  });
  return {
    status: res.status,
    body: res.status === 200 ? ((await res.json()) as object) : null,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("group roster audience", () => {
  it("the plan's own expert reads the roster and what each seat paid", async () => {
    seedWebinar();
    const { status, body } = await readAs("host-user");
    expect(status).toBe(200);
    expect(body).toHaveProperty("participants.0.id", "buyer-a");
    expect(body).toHaveProperty("seatPayments.0.userId", "buyer-a");
  });

  it("a presenter reads the roster, and no payment is read for them", async () => {
    seedWebinar();
    const { status, body } = await readAs("cohost-user");
    expect(status).toBe(200);
    expect(body).toHaveProperty("participants.0.id", "buyer-a");
    expect(body).not.toHaveProperty("seatPayments");
    expect(mockRosterDb.payment.findMany).not.toHaveBeenCalled();
  });

  it("crew get the 404 of a missing event", async () => {
    seedWebinar();
    const { status } = await readAs("crew-user");
    expect(status).toBe(404);
  });
});
