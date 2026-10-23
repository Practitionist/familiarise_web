/** @jest-environment node */

jest.mock("../../lib/stream/support-intervention", () => ({
  __esModule: true,
  joinIntervention: jest.fn(async () => "joined"),
  leaveIntervention: jest.fn(async () => "left"),
}));
jest.mock("../../lib/stream/support-boundary", () => ({
  __esModule: true,
  syncSupportBoundary: jest.fn(async () => "locked"),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  __esModule: true,
  stageBell: jest.fn(async (_tx: unknown, args: { dedupeKey: string }) => ({
    id: `bell:${args.dedupeKey}`,
  })),
}));

type Row = Record<string, unknown>;
const mockScans: Record<string, Row[]> = {};
const mockTx = {
  supportCaseChatAccess: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findMany: jest.fn(async (): Promise<Row[]> => []),
  },
  supportCaseEvent: { create: jest.fn(async () => ({})) },
  supportCase: {
    findUniqueOrThrow: jest.fn(async () => ({
      id: "case-1",
      referenceNumber: "FAM-2026-000001",
      organizationId: null,
      ownershipScope: "PERSONAL",
      submitterUserId: "u-learner",
      externalRequesterEmail: null,
    })),
  },
  user: {
    findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id })),
    ),
  },
  membership: { findMany: jest.fn(async () => []) },
};

function scanKey(where: Row): string {
  if ("reviewNoticeAt" in where) return "notice";
  if (!("endedAt" in where) && "OR" in where) return "boundary";
  if (where.kind === "INTERVENE" && where.endedAt === null) return "join";
  if (where.kind === "INTERVENE") return "leave";
  return "end";
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  ALLOCATION_TX_MAX_WAIT_MS: 5000,
  ALLOCATION_TX_TIMEOUT_MS: 15000,
  default: {
    supportCaseChatAccess: {
      findMany: jest.fn(
        async (args: { where: Row }) => mockScans[scanKey(args.where)] ?? [],
      ),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
  },
}));

import type { StagedTrigger } from "../../lib/novu/outbox";
import {
  joinIntervention,
  leaveIntervention,
} from "../../lib/stream/support-intervention";
import { stageBell } from "../../lib/novu/stage-bell";
import { syncSupportBoundary } from "../../lib/stream/support-boundary";
import { sweepSupportChatAccess } from "../../lib/support/chat-sweep";

const NOW = new Date("2026-10-20T10:00:00Z");

async function sweep() {
  const errors: string[] = [];
  const stagedBells: StagedTrigger[] = [];
  const result = await sweepSupportChatAccess({
    limit: 10,
    now: NOW,
    errors,
    stagedBells,
  });
  return { result, errors, stagedBells };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockScans)) delete mockScans[key];
});

it("ends expired grants as EXPIRED and grants on resolved or deleted cases as CASE_RESOLVED", async () => {
  mockScans.end = [
    {
      id: "g-expired",
      caseId: "c1",
      kind: "READ",
      supportCase: { status: "IN_PROGRESS", deletedAt: null },
    },
    {
      id: "g-resolved",
      caseId: "c2",
      kind: "INTERVENE",
      supportCase: { status: "RESOLVED", deletedAt: null },
    },
    {
      id: "g-deleted",
      caseId: "c3",
      kind: "READ",
      supportCase: { status: "OPEN", deletedAt: NOW },
    },
  ];
  const { result, errors } = await sweep();
  expect(errors).toEqual([]);
  expect(result.ended).toBe(3);
  const reasons = mockTx.supportCaseChatAccess.updateMany.mock.calls.map(
    (call) =>
      (call as unknown as [{ data: { endReason: string } }])[0].data.endReason,
  );
  expect(reasons).toEqual(["EXPIRED", "CASE_RESOLVED", "CASE_RESOLVED"]);
  expect(mockTx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      kind: "CHAT_ACCESS_ENDED",
      toValue: "g-resolved",
      note: "CASE_RESOLVED",
      actorId: null,
    }),
  });
});

it("retries the Stream leave for ended interventions still seated", async () => {
  mockScans.leave = [{ id: "g1" }, { id: "g2" }];
  const { result } = await sweep();
  expect(leaveIntervention).toHaveBeenCalledTimes(2);
  expect(result.left).toBe(2);
});

it("retries the join for live unjoined interventions and ends a deleted channel's grant", async () => {
  mockScans.join = [
    { id: "g-ok", caseId: "c1", kind: "INTERVENE" },
    { id: "g-gone", caseId: "c2", kind: "INTERVENE" },
    { id: "g-frozen", caseId: "c3", kind: "INTERVENE" },
  ];
  jest
    .mocked(joinIntervention)
    .mockResolvedValueOnce("joined")
    .mockResolvedValueOnce("gone")
    .mockResolvedValueOnce("frozen");
  const { result } = await sweep();
  expect(result.joined).toBe(1);
  expect(mockTx.supportCaseChatAccess.updateMany).toHaveBeenCalledTimes(1);
  expect(mockTx.supportCaseChatAccess.updateMany).toHaveBeenCalledWith({
    where: { id: "g-gone", endedAt: null },
    data: expect.objectContaining({ endReason: "CHANNEL_GONE" }),
  });
});

it("sends the post-decision notice once per batch of ended grants through the outbox", async () => {
  mockScans.notice = [{ caseId: "case-1" }, { caseId: "case-1" }];
  mockTx.supportCaseChatAccess.findMany.mockResolvedValueOnce([
    { id: "g1", scopeUserIds: ["u-learner", "u-host"], withholdNotice: false },
    { id: "g2", scopeUserIds: ["u-learner"], withholdNotice: false },
  ]);
  mockTx.supportCaseChatAccess.updateMany.mockResolvedValueOnce({ count: 2 });
  const { result, stagedBells } = await sweep();
  expect(result.notices).toBe(1);
  expect(mockTx.supportCaseChatAccess.updateMany).toHaveBeenCalledWith({
    where: { id: { in: ["g1", "g2"] }, reviewNoticeAt: null },
    data: { reviewNoticeAt: NOW },
  });
  // The requester gets the case link; the other party only the help article.
  const calls = jest.mocked(stageBell).mock.calls.map((call) => call[1]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    recipients: ["u-learner"],
    payload: expect.objectContaining({ reference: "FAM-2026-000001" }),
  });
  expect(calls[1]).toMatchObject({ recipients: ["u-host"] });
  expect(calls[1].payload).not.toHaveProperty("reference");
  expect(stagedBells).toHaveLength(2);
  expect(mockTx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      caseId: "case-1",
      kind: "CHAT_REVIEW_NOTIFIED",
      note: "sent (2 grant(s))",
    }),
  });
});

it("records a withheld notice without staging any bell", async () => {
  mockScans.notice = [{ caseId: "case-1" }];
  mockTx.supportCaseChatAccess.findMany.mockResolvedValueOnce([
    { id: "g1", scopeUserIds: ["u-learner"], withholdNotice: true },
  ]);
  const { result, stagedBells } = await sweep();
  expect(result.notices).toBe(1);
  expect(stageBell).not.toHaveBeenCalled();
  expect(stagedBells).toEqual([]);
  expect(mockTx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      kind: "CHAT_REVIEW_NOTIFIED",
      note: "withheld",
    }),
  });
});

it("only notices resolved or closed cases with no live grant left", async () => {
  await sweep();
  const prisma = jest.requireMock("../../lib/prisma").default;
  const noticeScan = (
    prisma.supportCaseChatAccess.findMany.mock.calls as [{ where: Row }][]
  ).find(([args]) => "reviewNoticeAt" in args.where);
  expect(noticeScan?.[0].where).toMatchObject({
    endedAt: { not: null },
    reviewNoticeAt: null,
    supportCase: {
      status: { in: ["RESOLVED", "CLOSED"] },
      deletedAt: null,
      chatAccess: { none: { endedAt: null } },
    },
  });
});

it("collects failures into the shared errors without throwing", async () => {
  mockScans.leave = [{ id: "g1" }];
  jest.mocked(leaveIntervention).mockRejectedValueOnce(new Error("stream 500"));
  mockScans.join = [{ id: "g2", caseId: "c", kind: "INTERVENE" }];
  jest.mocked(joinIntervention).mockRejectedValueOnce(new Error("timeout"));
  const { errors } = await sweep();
  expect(errors).toEqual([
    "chat-access leave g1: stream 500",
    "chat-access join g2: timeout",
  ]);
});

describe("channel lock backstop", () => {
  it("re-syncs each channel with a grant started or ended in the last six hours, once", async () => {
    mockScans.boundary = [
      { channelType: "messaging", channelId: "dm-a-b" },
      { channelType: "team", channelId: "webinar-web-1" },
      { channelType: "messaging", channelId: "dm-a-b" },
    ];
    jest
      .mocked(syncSupportBoundary)
      .mockResolvedValueOnce("unlocked")
      .mockResolvedValueOnce("gone");
    const { result, errors } = await sweep();
    expect(errors).toEqual([]);
    expect(jest.mocked(syncSupportBoundary).mock.calls).toEqual([
      ["messaging", "dm-a-b", NOW],
      ["team", "webinar-web-1", NOW],
    ]);
    expect(result.boundaries).toBe(1);
    const prisma = jest.requireMock("../../lib/prisma").default;
    const scan = (
      prisma.supportCaseChatAccess.findMany.mock.calls as [
        { where: Row; take: number },
      ][]
    ).find(([args]) => scanKey(args.where) === "boundary");
    const since = new Date(NOW.getTime() - 6 * 3_600_000);
    expect(scan?.[0]).toMatchObject({
      where: {
        OR: [{ createdAt: { gte: since } }, { endedAt: { gte: since } }],
      },
      take: 10,
    });
  });

  it("runs after ends and leaves and before join retries", async () => {
    mockScans.leave = [{ id: "g1" }];
    mockScans.boundary = [{ channelType: "messaging", channelId: "dm-a-b" }];
    mockScans.join = [{ id: "g2", caseId: "c", kind: "INTERVENE" }];
    await sweep();
    const order = (fn: unknown) =>
      jest.mocked(fn as jest.Mock).mock.invocationCallOrder[0];
    expect(order(leaveIntervention)).toBeLessThan(order(syncSupportBoundary));
    expect(order(syncSupportBoundary)).toBeLessThan(order(joinIntervention));
  });

  it("folds a failed sync into the shared errors", async () => {
    mockScans.boundary = [{ channelType: "messaging", channelId: "dm-a-b" }];
    jest
      .mocked(syncSupportBoundary)
      .mockRejectedValueOnce(new Error("stream 503"));
    const { result, errors } = await sweep();
    expect(result.boundaries).toBe(0);
    expect(errors).toEqual([
      "chat-access boundary messaging:dm-a-b: stream 503",
    ]);
  });
});
