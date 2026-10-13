/**
 * @jest-environment node
 */

/**
 * GET /api/scheduling/appointments/[appointmentId] on a group appointment: an
 * attendee's read carries their own userId in the payment/participant WHERE, so
 * another buyer's rows never leave the database; an accepted co-host reads every
 * seat. Neither read selects email.
 */

const mockSeatScopeFindUnique = jest.fn();
const mockSeatScopeAuth = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (...a: unknown[]) => mockSeatScopeFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockSeatScopeAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));

type Where = { userId?: string } | undefined;
const rows = (where: Where) =>
  ["buyer-a", "buyer-b"]
    .filter((userId) => !where?.userId || where.userId === userId)
    .map((userId) => ({ userId, user: { id: userId, name: userId } }));

function seedAppointment(viewerHoldsSeat: boolean) {
  mockSeatScopeFindUnique.mockImplementation(
    async (args: {
      select?: unknown;
      include?: {
        payment: { where?: Where };
        participants: { where?: Where };
      };
    }) => {
      if (args.select) {
        return {
          participants: viewerHoldsSeat ? [{ id: "seat" }] : [],
          consultation: null,
          subscription: null,
          webinar: {
            webinarPlan: {
              consultantProfileId: "host-profile",
              collaborators: [{ consultantProfileId: "cohost-profile" }],
            },
          },
          class: null,
        };
      }
      return {
        id: "appt-1",
        webinarId: "web-1",
        payment: rows(args.include?.payment.where),
        participants: rows(args.include?.participants.where),
      };
    },
  );
}

async function readAs(user: Record<string, unknown>) {
  mockSeatScopeAuth.mockResolvedValue({ session: { user } });
  const { GET } =
    await import("../../app/api/scheduling/appointments/[appointmentId]/route");
  const res = await GET(new Request("http://x") as never, {
    params: Promise.resolve({ appointmentId: "appt-1" }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      data: { payment: { userId: string }[]; participants: unknown[] };
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe("appointment detail seat scope", () => {
  it("an attendee never receives another buyer's payment or seat", async () => {
    seedAppointment(true);
    const { status, body } = await readAs({ id: "buyer-a", role: "CONSULTEE" });
    expect(status).toBe(200);
    expect(body.data.payment.map((p) => p.userId)).toEqual(["buyer-a"]);
    expect(body.data.participants).toHaveLength(1);
    const read = mockSeatScopeFindUnique.mock.calls[1][0];
    expect(read.include.payment.where).toEqual({ userId: "buyer-a" });
    expect(read.include.payment.select.user.select).not.toHaveProperty("email");
    expect(read.include.participants.include.user.select).not.toHaveProperty(
      "email",
    );
  });

  it("an accepted co-host reads every seat", async () => {
    seedAppointment(false);
    const { status, body } = await readAs({
      id: "cohost-user",
      role: "CONSULTANT",
      consultantProfileId: "cohost-profile",
    });
    expect(status).toBe(200);
    expect(body.data.payment.map((p) => p.userId)).toEqual([
      "buyer-a",
      "buyer-b",
    ]);
  });

  it("a stranger is refused", async () => {
    seedAppointment(false);
    const { status } = await readAs({ id: "stranger", role: "CONSULTEE" });
    expect(status).toBe(403);
  });
});
