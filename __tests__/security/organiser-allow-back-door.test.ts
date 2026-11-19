/**
 * @jest-environment node
 */

/**
 * POST /api/participants/webinar/[webinarId]/allow-back is the organiser's door:
 * platform staff are not admitted through it, so a staff lift takes the step-up
 * staff route and its audit row.
 */

const mockAuth = jest.fn();
const mockLift = jest.fn(async () => ({
  rejoinPath: "REGISTER",
  conduct: false,
}));
const mockDb = {
  membership: { findMany: jest.fn(async () => []) },
  // An event read narrowed to the caller's own plans finds nothing for staff outside the event.
  webinar: {
    findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
      "webinarPlan" in args.where ? null : { id: "web-1" },
    ),
  },
  appointment: { findFirst: jest.fn(async () => ({ id: "appt-1" })) },
};

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: mockDb }));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: () => mockAuth(),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (message: string) =>
    jest
      .requireActual<typeof import("next/server")>("next/server")
      .NextResponse.json({ error: message }, { status: 403 }),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  participantReadLimiter: {},
}));
jest.mock("../../lib/booking/seat-removal-lift", () => ({
  liftSeatRemovalAsOrganiser: (args: unknown) => mockLift(args),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(),
}));
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  refundRemovedAttendeeSeat: jest.fn(),
}));

// Required after the mocks above exist, since the route reads the client as it loads.
const allowBack = async () => {
  const { POST } =
    await import("@/app/api/participants/webinar/[webinarId]/allow-back/route");
  return POST(
    new Request("https://x.invalid/api/participants/webinar/web-1/allow-back", {
      method: "POST",
      body: JSON.stringify({ userId: "u-1" }),
    }),
    { params: Promise.resolve({ webinarId: "web-1" }) },
  );
};

beforeEach(() => jest.clearAllMocks());

it.each(["STAFF", "ADMIN"])(
  "refuses %s with no part in the event, lifting nothing",
  async (role) => {
    mockAuth.mockReturnValue({
      session: { user: { id: "staff-1", role, consultantProfileId: null } },
    });
    const res = await allowBack();
    expect(res.status).toBe(403);
    expect(mockLift).not.toHaveBeenCalled();
  },
);
