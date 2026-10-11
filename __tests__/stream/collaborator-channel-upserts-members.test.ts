/**
 * #1580 — the collaborator coordination channel is created with members Stream
 * has never seen unless they are upserted first; every other creator in
 * channel.action.ts does so, this one did not, and the channel never existed
 * (Sentry FAMILIARISE_WEB-37). Pins the upsert-before-create order.
 */

const mockChannel = {
  create: jest.fn(),
  query: jest.fn(),
  addMembers: jest.fn().mockResolvedValue({}),
  removeMembers: jest.fn().mockResolvedValue({}),
  assignRoles: jest.fn().mockResolvedValue({}),
  updatePartial: jest.fn().mockResolvedValue({}),
  id: "collab-webinar-plan-1",
  type: "messaging",
};
const mockStreamClient = { channel: jest.fn(), queryChannels: jest.fn() };
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockCache = {
  isChannelCached: jest.fn(() => false),
  markChannelExists: jest.fn(),
  initialSyncCompletedUsers: new Set<string>(),
};
const calls: string[] = [];

const mockWebinarPlanFindUnique = jest.fn(async () => ({
  title: "Intro Webinar",
  organizationId: null as string | null,
  consultantProfile: { user: { id: "host-user" } },
  collaborators: [{ consultantProfile: { user: { id: "collab-user" } } }],
}));

const mockClassPlanFindUnique = jest.fn(async () => ({
  title: "Advanced Class",
  organizationId: "org-enterprise-1" as string | null,
  consultantProfile: { user: { id: "host-user" } },
  collaborators: [{ consultantProfile: { user: { id: "collab-user" } } }],
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: {
      findUnique: (...args: unknown[]) =>
        mockWebinarPlanFindUnique(...(args as [])),
    },
    classPlan: {
      findUnique: (...args: unknown[]) =>
        mockClassPlanFindUnique(...(args as [])),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
  withStreamCircuitBreaker: jest.fn((op: () => unknown) => op()),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: jest.fn(() => false),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: mockLogger }));
jest.mock("../../lib/stream-cache", () => mockCache);
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn(async (ids: string[]) => {
    calls.push(`upsert:${ids.join(",")}`);
    return { users: {}, droppedIds: [] };
  }),
}));

describe("createCollaboratorChannel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockChannel.addMembers.mockResolvedValue({});
    mockChannel.removeMembers.mockResolvedValue({});
    mockChannel.assignRoles.mockResolvedValue({});
  });

  it("upserts the host and every accepted collaborator before creating the channel", async () => {
    // Imported here, after the mocks above are initialised (hoisting).
    const { createCollaboratorChannel } =
      await import("../../actions/stream/chat/channel.action");
    mockChannel.create.mockImplementation(async () => {
      calls.push("create");
      return {};
    });
    mockChannel.query.mockResolvedValue({
      members: [{ user_id: "host-user" }, { user_id: "collab-user" }],
    });

    await createCollaboratorChannel("webinar", "plan-1");

    expect(calls.slice(0, 2)).toEqual([
      "upsert:host-user,collab-user",
      "create",
    ]);
    const createPayload = mockStreamClient.channel.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(createPayload.organization_id).toBeUndefined();
  });

  it("stamps organization_id when plan.organizationId is set", async () => {
    const { createCollaboratorChannel } =
      await import("../../actions/stream/chat/channel.action");
    mockChannel.create.mockResolvedValue({});
    mockChannel.query.mockResolvedValue({
      members: [{ user_id: "host-user" }, { user_id: "collab-user" }],
    });

    await createCollaboratorChannel("class", "class-plan-org");

    expect(mockStreamClient.channel).toHaveBeenCalledWith(
      "messaging",
      "collab-class-class-plan-org",
      expect.objectContaining({
        class_plan_id: "class-plan-org",
        is_collaborator_channel: true,
        organization_id: "org-enterprise-1",
      }),
    );
  });

  it("chunks >100 collaborator members across create, addRemainingMembers, and reconciliation", async () => {
    const { createCollaboratorChannel } =
      await import("../../actions/stream/chat/channel.action");

    const collaborators = Array.from({ length: 149 }, (_, i) => ({
      consultantProfile: { user: { id: `collab-${i}` } },
    }));
    mockWebinarPlanFindUnique.mockResolvedValueOnce({
      title: "Mega Summit",
      organizationId: "org-summit",
      consultantProfile: { user: { id: "host-user" } },
      collaborators,
    });
    mockChannel.create.mockResolvedValue({});
    const departedMembers = Array.from({ length: 120 }, (_, i) => ({
      user_id: `departed-${i}`,
    }));
    mockChannel.query.mockResolvedValue({
      members: [{ user_id: "host-user" }, ...departedMembers],
    });

    await createCollaboratorChannel("webinar", "plan-mega");

    const createData = mockStreamClient.channel.mock.calls[0]?.[2] as {
      members: string[];
      organization_id?: string;
    };
    expect(createData.organization_id).toBe("org-summit");
    expect(createData.members).toHaveLength(100);
    expect(createData.members[0]).toBe("host-user");

    // First addMembers call is addRemainingMembers (50 remaining after initial 100);
    // subsequent calls are reconciliation of missing 149 collaborators (100 + 49).
    const addBatches = mockChannel.addMembers.mock.calls.map(
      ([batch]: [string[]]) => batch.length,
    );
    expect(addBatches).toEqual([50, 100, 49]);

    const removeBatches = mockChannel.removeMembers.mock.calls.map(
      ([batch]: [string[]]) => batch.length,
    );
    expect(removeBatches).toEqual([100, 20]);
  });
});
