/** @jest-environment node */

interface ReportRow {
  id: string;
  reportedById: string;
  targetUserId: string;
  type: string;
  reviewId: string | null;
  streamMessageId: string | null;
  contentText: string | null;
  status: string;
}
const rows: ReportRow[] = [];
const mockGetMessage = jest.fn();
const mockQueryChannels = jest.fn();
const mockCreate = jest.fn();
const mockReview = jest.fn();
const mockMembership = jest.fn();
const mockSession = jest.fn();
const mockFindFirst = jest.fn(
  async ({ where }) =>
    rows.find(
      (row) =>
        row.reportedById === where.reportedById &&
        row.targetUserId === where.targetUserId &&
        row.type === where.type &&
        row.reviewId === where.reviewId &&
        row.streamMessageId === where.streamMessageId &&
        where.status.in.includes(row.status),
    ) ?? null,
);

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    getMessage: mockGetMessage,
    queryChannels: mockQueryChannels,
  }),
  withStreamCircuitBreaker: (fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { warn: jest.fn() },
}));
jest.mock("../../lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("../../lib/rate-limit", () => ({
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    },
    user: { findUnique: jest.fn(async () => ({ id: "target" })) },
    consultantReview: {
      findFirst: (...args: unknown[]) => mockReview(...args),
    },
    membership: { findFirst: (...args: unknown[]) => mockMembership(...args) },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/report/route";

const post = (overrides: Record<string, unknown> = {}) =>
  POST(
    new NextRequest("https://test/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "MESSAGE",
        reason: "Harassment",
        targetUserId: "target",
        streamMessageId: "message",
        ...overrides,
      }),
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  rows.length = 0;
  mockSession.mockResolvedValue({ user: { id: "reporter" } });
  mockGetMessage.mockImplementation(async (id: string) => ({
    message: {
      id,
      cid: "messaging:canonical",
      text: "canonical text",
      user: { id: "target" },
    },
  }));
  mockQueryChannels.mockResolvedValue([{ data: {} }]);
  mockReview.mockResolvedValue({
    reviewDescription: "Review snapshot",
    consultantProfile: { userId: "reporter" },
    consulteeProfile: { userId: "target" },
    appointment: { organizationId: null },
  });
  mockMembership.mockResolvedValue(null);
  mockCreate.mockImplementation(async ({ data }) => {
    const row = { ...data, id: `report-${rows.length + 1}`, status: "PENDING" };
    rows.push(row);
    return row;
  });
});

it("gives each reporter a distinct receipt without changing anyone else's evidence", async () => {
  const first = await (
    await post({ description: "first reporter's statement" })
  ).json();
  mockSession.mockResolvedValue({ user: { id: "second-reporter" } });
  const second = await (
    await post({ description: "second reporter's statement" })
  ).json();
  expect(first.reportId).not.toBe(second.reportId);
  expect(first.reportReference).not.toBe(second.reportReference);
  expect(rows).toHaveLength(2);
  expect(mockCreate.mock.calls.map(([args]) => args.data.description)).toEqual([
    "first reporter's statement",
    "second reporter's statement",
  ]);
});

it("keeps different messages by one author separate", async () => {
  await post();
  expect((await post({ streamMessageId: "other-message" })).status).toBe(201);
  expect(rows).toHaveLength(2);
});

it.each(["PENDING", "UNDER_REVIEW", "ESCALATED"])(
  "returns the reporter's existing reference for a duplicate %s report",
  async (status) => {
    const original = await (await post()).json();
    rows[0].status = status;
    const duplicate = await post();
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      reportId: original.reportId,
      reportReference: original.reportReference,
    });
    expect(rows).toHaveLength(1);
  },
);

it("allows a new report after the previous one is resolved", async () => {
  await post();
  rows[0].status = "DISMISSED";
  expect((await post()).status).toBe(201);
});

it("uses canonical message text and channel and proves reporter membership before storing them", async () => {
  expect(
    (
      await post({
        contentText: "forged text",
        streamChannelCid: "messaging:forged",
      })
    ).status,
  ).toBe(201);
  expect(mockQueryChannels).toHaveBeenCalledWith(
    { cid: { $eq: "messaging:canonical" }, members: { $in: ["reporter"] } },
    {},
    { limit: 1, state: false, watch: false },
  );
  expect(rows[0]).toMatchObject({
    streamMessageId: "message",
    streamChannelCid: "messaging:canonical",
    contentText: "canonical text",
  });
});

it("rejects a known message in a channel the reporter cannot access", async () => {
  mockQueryChannels.mockResolvedValue([]);
  expect((await post()).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
});

it("rejects an author mismatch without persisting forged evidence", async () => {
  mockGetMessage.mockResolvedValue({
    message: {
      id: "message",
      cid: "messaging:canonical",
      user: { id: "other-person" },
    },
  });
  expect((await post()).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
});

it("asks the reporter to retry when Stream verification fails", async () => {
  mockGetMessage.mockRejectedValue(new Error("unavailable"));
  expect((await post()).status).toBe(503);
  expect(mockCreate).not.toHaveBeenCalled();
});

it("requires a canonical message identity", async () => {
  expect((await post({ streamMessageId: undefined })).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

it("derives organization from the verified channel and refuses a forged organization", async () => {
  mockQueryChannels.mockResolvedValue([
    { data: { organization_id: "real-org" } },
  ]);
  expect((await post({ organizationId: "forged-org" })).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
  expect((await post()).status).toBe(201);
  expect(mockCreate.mock.calls[0][0].data.organizationId).toBe("real-org");
});

it("rejects caller-only organization attribution on profile reports", async () => {
  expect(
    (await post({ type: "PROFILE", organizationId: "forged-org" })).status,
  ).toBe(403);
  expect(mockMembership).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it("uses a review's own author and organization without exposing an anonymous author's identity", async () => {
  const response = await post({
    type: "REVIEW",
    reason: "SPAM_OR_FAKE",
    reviewId: "review",
    targetUserId: "guessed-author",
  });
  expect(response.status).toBe(201);
  expect(rows[0]).toMatchObject({
    targetUserId: "target",
    reviewId: "review",
    streamMessageId: null,
    contentText: "Review snapshot",
  });
  expect(await response.json()).not.toHaveProperty("targetUserId");
});

it("refuses missing or removed reviews", async () => {
  mockReview.mockResolvedValue(null);
  expect(
    (
      await post({
        type: "REVIEW",
        reason: "SPAM_OR_FAKE",
        reviewId: "removed",
      })
    ).status,
  ).toBe(404);
  expect(mockReview.mock.calls[0][0].where).toEqual({
    id: "removed",
    deletedAt: null,
  });
});

it("does not bind unrelated review or message identities to profile reports", async () => {
  expect((await post({ type: "PROFILE", reviewId: "review" })).status).toBe(
    201,
  );
  expect(rows[0]).toMatchObject({ reviewId: null, streamMessageId: null });
  expect(mockGetMessage).not.toHaveBeenCalled();
});

it("handles a concurrent duplicate enforced by the database without a server error", async () => {
  mockCreate.mockRejectedValueOnce({ code: "P2002" });
  expect((await post()).status).toBe(409);
});
