/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockCreateCollaboratorChannel = jest.fn();
const mockAddMembers = jest.fn(async () => ({}));
const mockWebinarPlanFindUnique = jest.fn();
const mockFence = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "host-user", role: "CONSULTANT" } },
  }),
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  streamApiLimiter: {},
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: {
      findUnique: (...args: unknown[]) => mockWebinarPlanFindUnique(...args),
    },
  },
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createCollaboratorChannel: (...args: unknown[]) =>
    mockCreateCollaboratorChannel(...args),
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream/access-revocation", () => ({
  fenceCollaboratorGrant: (...args: unknown[]) => mockFence(...args),
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: jest.fn(async () => ({})),
  upsertUserToStream: jest.fn(),
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: () => ({ addMembers: mockAddMembers }),
  }),
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: () => false,
}));

const plan = (status: string) => ({
  id: "plan-1",
  organizationId: "org-1",
  organization: { status },
  consultantProfile: { userId: "host-user" },
  collaborators: [],
});

async function openCollab() {
  const { POST } = await import("../../app/api/stream/channels/open/route");
  return POST(
    new NextRequest("http://localhost/api/stream/channels/open", {
      method: "POST",
      body: JSON.stringify({ kind: "collab", webinarPlanId: "plan-1" }),
    }),
  );
}

describe("collaborator channel open", () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses the host of a DEACTIVATED org before touching Stream", async () => {
    mockWebinarPlanFindUnique.mockResolvedValue(plan("DEACTIVATED"));

    const res = await openCollab();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "ORG_DEACTIVATED",
    });
    expect(mockCreateCollaboratorChannel).not.toHaveBeenCalled();
  });

  it("refuses a frozen channel instead of reopening it", async () => {
    mockWebinarPlanFindUnique.mockResolvedValue(plan("ACTIVE"));
    mockCreateCollaboratorChannel.mockResolvedValue({
      channelId: "collab-webinar-plan-1",
      members: ["host-user", "collab-user"],
      frozen: true,
    });

    const res = await openCollab();

    expect(res.status).toBe(423);
    await expect(res.json()).resolves.toMatchObject({ code: "CHANNEL_FROZEN" });
    expect(mockAddMembers).not.toHaveBeenCalled();
  });

  const openChannel = { channelId: "collab-webinar-plan-1", frozen: false };

  it("re-checks a collaborator after the add: an ended one is refused, an unread one is not vouched for", async () => {
    mockWebinarPlanFindUnique.mockResolvedValue({
      ...plan("ACTIVE"),
      consultantProfile: { userId: "owner-user" },
      collaborators: [{ consultantProfile: { userId: "host-user" } }],
    });
    mockCreateCollaboratorChannel.mockResolvedValue(openChannel);
    mockFence.mockResolvedValueOnce({ verified: true, lost: true });
    mockFence.mockResolvedValueOnce({ verified: false });

    const ended = await openCollab();
    const unread = await openCollab();

    expect(mockFence).toHaveBeenCalledWith(
      { planType: "webinar", planId: "plan-1" },
      "host-user",
    );
    expect(ended.status).toBe(403);
    expect(unread.status).toBe(503);
  });

  it("never re-checks a collaboration for the plan owner", async () => {
    mockWebinarPlanFindUnique.mockResolvedValue(plan("ACTIVE"));
    mockCreateCollaboratorChannel.mockResolvedValue(openChannel);

    const res = await openCollab();

    expect(res.status).toBe(200);
    expect(mockFence).not.toHaveBeenCalled();
  });
});
