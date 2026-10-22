/** @jest-environment node */

const mockCalls: string[] = [];
const mockChannel = {
  addMembers: jest.fn(async () => {
    mockCalls.push("addMembers");
    return {};
  }),
  removeMembers: jest.fn(async () => {
    mockCalls.push("removeMembers");
    return {};
  }),
  sendMessage: jest.fn(async (message: { type?: string }) => {
    mockCalls.push(`sendMessage:${message.type ?? "regular"}`);
    return { message };
  }),
  watch: jest.fn(),
};
const mockChat = {
  channel: jest.fn(() => mockChannel),
  upsertUser: jest.fn(async () => {
    mockCalls.push("upsertUser");
    return {};
  }),
  queryChannels: jest.fn(
    async (): Promise<{ data: { frozen?: boolean } }[]> => [
      { data: { frozen: false } },
    ],
  ),
};

jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: () => mockChat,
  withStreamCircuitBreaker: (op: () => Promise<unknown>) => op(),
  isExpectedStreamError: (err: unknown) =>
    (err as { status?: number })?.status === 404,
  streamErrorCode: (err: unknown) =>
    typeof (err as { code?: unknown })?.code === "number"
      ? (err as { code: number }).code
      : null,
}));

const mockGrant: { current: Record<string, unknown> | null } = {
  current: null,
};
const mockSuccessor: { current: { id: string } | null } = { current: null };
const mockTx = {
  supportCaseEvent: {
    findFirst: jest.fn(async (): Promise<{ actorId: string } | null> => null),
    create: jest.fn(async () => {
      mockCalls.push("event");
      return {};
    }),
  },
  opsActionLog: {
    create: jest.fn(async () => {
      mockCalls.push("opsAction");
      return { id: "ops-1" };
    }),
  },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCaseChatAccess: {
      findUnique: jest.fn(async () => mockGrant.current),
      findFirst: jest.fn(async (args: { where: { endedAt?: null } }) =>
        args.where.endedAt === null ? mockSuccessor.current : mockGrant.current,
      ),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
        mockCalls.push(`stamp:${Object.keys(args.data).join(",")}`);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
  },
}));

import prisma from "../../lib/prisma";
import {
  joinIntervention,
  leaveIntervention,
  postSupportMessage,
  supportMessageId,
} from "../../lib/stream/support-intervention";

const NOW = new Date("2026-10-20T10:00:00Z");
const liveIntervention = {
  kind: "INTERVENE",
  channelType: "messaging",
  channelId: "dm-a-b",
  endedAt: null,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  streamJoinedAt: null,
  streamLeftAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockGrant.current = { ...liveIntervention };
  mockSuccessor.current = null;
  mockChat.queryChannels.mockImplementation(async () => [
    { data: { frozen: false } },
  ]);
});

describe("joinIntervention", () => {
  it("upserts the support user, adds it as a member, stamps, then announces", async () => {
    await expect(joinIntervention("grant-1", NOW)).resolves.toBe("joined");
    expect(mockCalls).toEqual([
      "upsertUser",
      "addMembers",
      "stamp:streamJoinedAt",
      "sendMessage:system",
    ]);
    expect(mockChat.upsertUser).toHaveBeenCalledWith({
      id: "familiarise-support",
      name: "Familiarise Support",
      role: "user",
    });
    expect(mockChannel.addMembers).toHaveBeenCalledWith([
      "familiarise-support",
    ]);
    expect(mockChannel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fs-join-grant-1",
        type: "system",
        user_id: "familiarise-support",
        support_event: "support_joined",
      }),
    );
    expect(mockChannel.watch).not.toHaveBeenCalled();
  });

  it("probes without creating or watching the channel", async () => {
    await joinIntervention("grant-1", NOW);
    expect(mockChat.queryChannels).toHaveBeenCalledWith(
      { cid: { $eq: "messaging:dm-a-b" } },
      [],
      expect.objectContaining({ watch: false, state: true, limit: 1 }),
    );
  });

  it("refuses a frozen channel and leaves the grant unjoined", async () => {
    mockChat.queryChannels.mockImplementation(async () => [
      { data: { frozen: true } },
    ]);
    await expect(joinIntervention("grant-1", NOW)).resolves.toBe("frozen");
    expect(mockChannel.addMembers).not.toHaveBeenCalled();
    expect(prisma.supportCaseChatAccess.updateMany).not.toHaveBeenCalled();
  });

  it("reports a channel that no longer exists", async () => {
    mockChat.queryChannels.mockImplementation(async () => []);
    await expect(joinIntervention("grant-1", NOW)).resolves.toBe("gone");
    expect(mockChannel.addMembers).not.toHaveBeenCalled();
  });

  it("a failed add leaves streamJoinedAt null for the sweep to retry", async () => {
    mockChannel.addMembers.mockRejectedValueOnce(new Error("stream down"));
    await expect(joinIntervention("grant-1", NOW)).rejects.toThrow(
      "stream down",
    );
    expect(prisma.supportCaseChatAccess.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["ended", { endedAt: NOW }],
    ["already joined", { streamJoinedAt: NOW }],
    ["expired", { expiresAt: NOW }],
    ["a read grant", { kind: "READ" }],
  ])("skips %s", async (_label, patch) => {
    mockGrant.current = { ...liveIntervention, ...patch };
    await expect(joinIntervention("grant-1", NOW)).resolves.toBe("skipped");
    expect(mockChat.upsertUser).not.toHaveBeenCalled();
  });
});

describe("leaveIntervention", () => {
  const ended = {
    ...liveIntervention,
    endedAt: NOW,
    streamJoinedAt: new Date(NOW.getTime() - 1000),
  };

  it("announces before removing the member, then stamps", async () => {
    mockGrant.current = ended;
    await expect(leaveIntervention("grant-1", NOW)).resolves.toBe("left");
    expect(mockCalls).toEqual([
      "sendMessage:system",
      "removeMembers",
      "stamp:streamLeftAt",
    ]);
    expect(mockChannel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fs-leave-grant-1",
        support_event: "support_left",
        text: "Familiarise Support has left this chat.",
      }),
    );
  });

  it("keeps the seat when a newer intervention is live on the channel", async () => {
    mockGrant.current = ended;
    mockSuccessor.current = { id: "grant-2" };
    await expect(leaveIntervention("grant-1", NOW)).resolves.toBe(
      "handed-over",
    );
    expect(mockChannel.removeMembers).not.toHaveBeenCalled();
    expect(mockCalls).toEqual(["stamp:streamLeftAt"]);
  });

  it("counts a deleted channel as left", async () => {
    mockGrant.current = ended;
    mockChannel.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    await expect(leaveIntervention("grant-1", NOW)).resolves.toBe("left");
    expect(mockCalls).toEqual(["stamp:streamLeftAt"]);
  });

  it("a failed removal leaves streamLeftAt null for the sweep", async () => {
    mockGrant.current = ended;
    mockChannel.removeMembers.mockRejectedValueOnce(new Error("timeout"));
    await expect(leaveIntervention("grant-1", NOW)).rejects.toThrow("timeout");
    expect(prisma.supportCaseChatAccess.updateMany).not.toHaveBeenCalled();
  });

  it("skips a live or never-joined grant", async () => {
    await expect(leaveIntervention("grant-1", NOW)).resolves.toBe("skipped");
    mockGrant.current = { ...ended, streamJoinedAt: null };
    await expect(leaveIntervention("grant-1", NOW)).resolves.toBe("skipped");
    expect(mockChannel.removeMembers).not.toHaveBeenCalled();
  });
});

describe("postSupportMessage", () => {
  const joined = {
    ...liveIntervention,
    streamJoinedAt: new Date(NOW.getTime() - 1000),
  };
  const post = () =>
    postSupportMessage({
      caseId: "case-1",
      grantId: "grant-1",
      actor: { userId: "u-staff", role: "STAFF" },
      clientActionId: "draft_0001",
      text: "Please share the payment receipt here.",
      now: NOW,
    });

  it("audits before sending, with a deterministic id and no staff identity in Stream", async () => {
    mockGrant.current = joined;
    await expect(post()).resolves.toEqual({
      messageId: "fs-grant-1-draft_0001",
      replayed: false,
    });
    expect(supportMessageId("grant-1", "draft_0001")).toBe(
      "fs-grant-1-draft_0001",
    );
    expect(mockCalls).toEqual(["event", "opsAction", "sendMessage:regular"]);
    const [sent] = mockChannel.sendMessage.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(sent).toEqual({
      id: "fs-grant-1-draft_0001",
      text: "Please share the payment receipt here.",
      user_id: "familiarise-support",
      support_message: true,
    });
    expect(JSON.stringify(sent)).not.toContain("u-staff");
    expect(mockTx.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          surface: "supportChat.intervene",
          action: "support.chat.message.post",
          targetId: "grant-1",
        }),
      }),
    );
  });

  it("a retry with the same id replays the audit and treats a duplicate send as delivered", async () => {
    mockGrant.current = joined;
    mockTx.supportCaseEvent.findFirst.mockResolvedValueOnce({
      actorId: "u-staff",
    });
    mockChannel.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error("message with id already exists"), { code: 4 }),
    );
    await expect(post()).resolves.toEqual({
      messageId: "fs-grant-1-draft_0001",
      replayed: true,
    });
    expect(mockTx.supportCaseEvent.create).not.toHaveBeenCalled();
    expect(mockTx.opsActionLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no grant", null, "GRANT_NOT_FOUND"],
    ["an ended grant", { ...joined, endedAt: NOW }, "GRANT_ENDED"],
    ["an expired grant", { ...joined, expiresAt: NOW }, "GRANT_ENDED"],
    ["support not yet joined", liveIntervention, "NOT_JOINED"],
  ])("refuses %s without sending", async (_label, grant, code) => {
    mockGrant.current = grant;
    await expect(post()).rejects.toMatchObject({ code });
    expect(mockChannel.sendMessage).not.toHaveBeenCalled();
    expect(mockTx.supportCaseEvent.create).not.toHaveBeenCalled();
  });
});
