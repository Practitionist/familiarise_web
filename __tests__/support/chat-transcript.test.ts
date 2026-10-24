/** @jest-environment node */

const mockOrder: string[] = [];
const mockQuery = jest.fn();
const mockGetMessage = jest.fn(async (id: string) => ({
  message: { id, text: `original text of ${id}` },
}));
const mockChannel = { query: mockQuery, watch: jest.fn() };

jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: () => ({
    channel: jest.fn(() => mockChannel),
    getMessage: mockGetMessage,
  }),
  withStreamCircuitBreaker: (op: () => Promise<unknown>) => op(),
  isExpectedStreamError: (err: unknown) =>
    (err as { status?: number })?.status === 404,
  streamErrorCode: () => null,
}));

const mockRecordSystemEvent = jest.fn(async (_params: unknown) => {
  mockOrder.push("audit");
});
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemEvent: (params: unknown) => mockRecordSystemEvent(params),
}));

const mockGrantRow: { current: Record<string, unknown> | null } = {
  current: null,
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCaseChatAccess: {
      findFirst: jest.fn(async (args: { where: { grantedById: string } }) =>
        mockGrantRow.current &&
        mockGrantRow.current.grantedById === args.where.grantedById
          ? mockGrantRow.current
          : null,
      ),
    },
    supportCase: {
      findUnique: jest.fn(async () => ({ requesterUserId: "u-learner" })),
    },
  },
}));

import { readTranscriptPage } from "../../lib/support/chat-transcript";

const NOW = new Date("2026-10-20T10:00:00Z");
const WINDOW = new Date("2026-10-10T00:00:00Z");

function grant(patch: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    caseId: "case-1",
    kind: "READ",
    basis: "OPEN_CASE",
    grantedById: "u-staff",
    grantedBy: { name: "Staff" },
    channelType: "team",
    channelId: "webinar-web-1",
    scopeUserIds: ["u-learner", "u-host"],
    windowStart: WINDOW,
    organizationIds: [],
    withholdNotice: false,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    endedAt: null,
    endReason: null,
    streamJoinedAt: null,
    streamLeftAt: null,
    createdAt: NOW,
    ...patch,
  };
}

function msg(
  id: string,
  userId: string | null,
  at: string,
  patch: Record<string, unknown> = {},
) {
  return {
    id,
    text: `text ${id}`,
    type: "regular",
    created_at: at,
    user: userId ? { id: userId, name: userId } : undefined,
    attachments: [],
    ...patch,
  };
}

const read = (before?: string) =>
  readTranscriptPage({
    caseId: "case-1",
    grantId: "grant-1",
    actor: { userId: "u-staff", role: "STAFF" },
    before,
    now: NOW,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  mockGrantRow.current = grant();
  mockQuery.mockReset();
});

it("keeps only the reporter's, the targets', support and system messages in a group channel", async () => {
  mockQuery.mockResolvedValueOnce({
    messages: [
      msg("m1", "u-learner", "2026-10-15T00:00:00Z"),
      msg("m2", "u-peer", "2026-10-15T00:01:00Z"),
      msg("m3", "u-host", "2026-10-15T00:02:00Z"),
      msg("m4", "familiarise-support", "2026-10-15T00:03:00Z"),
      msg("m5", null, "2026-10-15T00:04:00Z", { type: "system" }),
    ],
  });
  const page = await read();
  expect(page.messages.map((m) => [m.id, m.role])).toEqual([
    ["m1", "reporter"],
    ["m3", "target"],
    ["m4", "support"],
    ["m5", "system"],
  ]);
  expect(page.nextBefore).toBeNull();
  expect(mockChannel.watch).not.toHaveBeenCalled();
  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({ watch: false, presence: false }),
  );
});

it("cuts the page at the window start and stops paging there", async () => {
  mockQuery.mockResolvedValueOnce({
    messages: [
      msg("old", "u-learner", "2026-10-01T00:00:00Z"),
      msg("new", "u-learner", "2026-10-12T00:00:00Z"),
    ],
  });
  const page = await read();
  expect(page.messages.map((m) => m.id)).toEqual(["new"]);
  expect(page.nextBefore).toBeNull();
  expect(page.windowStart).toBe(WINDOW.toISOString());
});

it("pages backwards with id_lt and returns the cursor for Load earlier", async () => {
  const full = Array.from({ length: 200 }, (_, i) =>
    msg(
      `m${i}`,
      "u-learner",
      new Date(Date.UTC(2026, 9, 15, 0, i)).toISOString(),
    ),
  );
  mockQuery.mockResolvedValueOnce({ messages: full });
  const page = await read("cursor-x");
  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: { limit: 200, id_lt: "cursor-x" },
    }),
  );
  expect(page.messages).toHaveLength(200);
  expect(page.nextBefore).toBe("m0");
});

it("reads a sparse group channel up to three pages to fill a screen", async () => {
  const noise = (offset: number) =>
    Array.from({ length: 200 }, (_, i) =>
      msg(
        `p${offset}-${i}`,
        "u-peer",
        new Date(Date.UTC(2026, 9, 18 - offset, 0, i)).toISOString(),
      ),
    );
  mockQuery
    .mockResolvedValueOnce({ messages: noise(0) })
    .mockResolvedValueOnce({ messages: noise(1) })
    .mockResolvedValueOnce({ messages: noise(2) });
  const page = await read();
  expect(mockQuery).toHaveBeenCalledTimes(3);
  expect(mockQuery.mock.calls[1][0].messages).toEqual({
    limit: 200,
    id_lt: "p0-0",
  });
  expect(page.messages).toHaveLength(0);
  expect(page.nextBefore).toBe("p2-0");
});

it("shows soft-deleted text through show_deleted_message and flags it", async () => {
  mockQuery.mockResolvedValueOnce({
    messages: [
      msg("gone", "u-host", "2026-10-15T00:00:00Z", {
        type: "deleted",
        text: "",
      }),
    ],
  });
  const page = await read();
  expect(mockGetMessage).toHaveBeenCalledWith("gone", {
    show_deleted_message: true,
  });
  expect(page.messages[0]).toMatchObject({
    text: "original text of gone",
    deletedBySender: true,
  });
});

it("projects attachments as names and types only", async () => {
  mockQuery.mockResolvedValueOnce({
    messages: [
      msg("a", "u-learner", "2026-10-15T00:00:00Z", {
        attachments: [
          {
            type: "image",
            title: "receipt.png",
            image_url: "https://cdn.example/receipt.png",
          },
        ],
      }),
    ],
  });
  const page = await read();
  expect(page.messages[0].attachments).toEqual([
    { type: "image", name: "receipt.png" },
  ]);
  expect(JSON.stringify(page)).not.toContain("cdn.example");
});

it("writes a strict SystemEvent before returning the page", async () => {
  mockQuery.mockResolvedValueOnce({
    messages: [msg("m1", "u-learner", "2026-10-15T00:00:00Z")],
  });
  await read("cursor-y");
  expect(mockRecordSystemEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "SUPPORT_CHAT_ACCESS",
      severity: "WARN",
      strict: true,
      correlationId: "grant-1",
      context: expect.objectContaining({
        actorUserId: "u-staff",
        caseId: "case-1",
        grantId: "grant-1",
        channelCid: "team:webinar-web-1",
        before: "cursor-y",
        messageCount: 1,
      }),
    }),
  );
});

it("serves nothing when the audit write fails", async () => {
  mockQuery.mockResolvedValueOnce({
    messages: [msg("m1", "u-learner", "2026-10-15T00:00:00Z")],
  });
  mockRecordSystemEvent.mockRejectedValueOnce(new Error("insert failed"));
  await expect(read()).rejects.toThrow("insert failed");
});

it("refuses another operator's grant", async () => {
  mockGrantRow.current = grant({ grantedById: "u-other-staff" });
  await expect(read()).rejects.toMatchObject({
    code: "GRANT_NOT_FOUND",
    httpStatus: 404,
  });
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockRecordSystemEvent).not.toHaveBeenCalled();
});

it.each([
  ["expired", { expiresAt: NOW }],
  ["ended", { endedAt: NOW, endReason: "ENDED_BY_STAFF" }],
])("refuses an %s grant with 410", async (_label, patch) => {
  mockGrantRow.current = grant(patch);
  await expect(read()).rejects.toMatchObject({
    code: "GRANT_ENDED",
    httpStatus: 410,
  });
  expect(mockQuery).not.toHaveBeenCalled();
});

it("maps a missing channel to CHAT_NOT_FOUND without auditing", async () => {
  mockQuery.mockRejectedValueOnce(
    Object.assign(new Error("not found"), { status: 404 }),
  );
  await expect(read()).rejects.toMatchObject({ code: "CHAT_NOT_FOUND" });
  expect(mockRecordSystemEvent).not.toHaveBeenCalled();
});

it("labels a DM requester as reporter and the other member as target", async () => {
  mockGrantRow.current = grant({
    channelType: "messaging",
    channelId: "dm-a-b",
    scopeUserIds: ["u-learner", "u-host"],
  });
  mockQuery.mockResolvedValueOnce({
    messages: [
      msg("m1", "u-host", "2026-10-15T00:00:00Z"),
      msg("m2", "u-learner", "2026-10-15T00:01:00Z"),
    ],
  });
  const page = await read();
  expect(page.messages.map((m) => m.role)).toEqual(["target", "reporter"]);
});
