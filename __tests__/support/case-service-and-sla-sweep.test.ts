/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/email/deliver", () => ({
  stage: jest.fn(async () => null),
}));
jest.mock("../../lib/novu/resolve-href", () => ({
  supportRequestHref: (key: string) => `/dashboard/support/${key}`,
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseMessage: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    supportCaseEvent: { create: jest.fn() },
    user: {
      findMany: jest.fn(async () => [{ id: "staff" }]),
      findUnique: jest.fn(),
    },
    membership: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    supportCaseCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  appendSupportCaseTurn,
  createOrReuseSupportCase,
  readSupportCaseForViewer,
  submitSupportCaseCsat,
  supportMonthlyComplianceReport,
} from "../../lib/support/case-service";
import { supportDeadline } from "../../lib/support/deadline-policy";
import { slaStateOf } from "../../lib/support/sla";
const cases = prisma.supportCase;
const now = new Date("2026-10-20T00:00:00Z");
const record = (overrides: Record<string, unknown> = {}) => ({
  id: "case",
  referenceNumber: "FAM-2026-000001",
  title: "Help",
  description: "Complaint",
  category: "GENERAL",
  status: "OPEN",
  requesterUserId: "customer",
  submitterUserId: "customer",
  ownershipScope: "PERSONAL",
  organizationId: null,
  appointmentId: null,
  externalRequesterEmail: null,
  assignedToId: null,
  createdAt: now,
  updatedAt: now,
  awaitingUserSince: null,
  pausedSeconds: 0,
  lastMessageAt: now,
  messageSeq: 1,
  deletedAt: null,
  resolvedAt: null,
  closedAt: null,
  csatRating: null,
  messages: [],
  subjects: [],
  events: [],
  ...overrides,
});
beforeEach(() => {
  jest.clearAllMocks();
  (cases.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (cases.findUnique as jest.Mock).mockResolvedValue(record());
  (cases.findUniqueOrThrow as jest.Mock).mockResolvedValue({ messageSeq: 2 });
  (prisma.supportCaseMessage.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.supportCaseMessage.create as jest.Mock).mockResolvedValue({
    id: "message",
    seq: 2,
  });
  (prisma.membership.findMany as jest.Mock).mockResolvedValue([]);
});
it("replays an intake only within its submitting party", async () => {
  (cases.findFirst as jest.Mock).mockResolvedValueOnce(record());
  const result = await createOrReuseSupportCase(
    {
      title: "Help",
      description: "Complaint",
      category: "GENERAL",
      requesterUserId: "customer",
      submitterUserId: "customer",
      clientIntakeId: "same-browser-retry",
    },
    now,
  );
  expect(result.reused).toBe(true);
  expect(cases.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        submitterUserId: "customer",
        clientIntakeId: "same-browser-retry",
      },
    }),
  );
  expect(cases.create).not.toHaveBeenCalled();
});
it("returns the winning case when a concurrent intake with the same retry key commits first", async () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed",
    { code: "P2002", clientVersion: "test" },
  );
  (prisma.$transaction as jest.Mock).mockRejectedValueOnce(duplicate);
  const winner = record({ id: "winner" });
  (cases.findFirst as jest.Mock).mockResolvedValueOnce(winner);
  const result = await createOrReuseSupportCase(
    {
      title: "Help",
      description: "Complaint",
      category: "GENERAL",
      requesterUserId: "customer",
      submitterUserId: "customer",
      clientIntakeId: "double-click",
    },
    now,
  );
  expect(result).toMatchObject({
    reused: true,
    dedupeReason: "client_intake_id",
    supportCase: { id: "winner" },
  });
  expect(cases.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { clientIntakeId: "double-click", submitterUserId: "customer" },
    }),
  );
  expect(cases.create).not.toHaveBeenCalled();
});
it("returns the original turn when a browser retries a customer reply", async () => {
  (prisma.supportCaseMessage.findUnique as jest.Mock).mockResolvedValueOnce({
    seq: 2,
  });
  (prisma.supportCaseMessage.findMany as jest.Mock).mockResolvedValueOnce([
    { id: "already-sent", seq: 2 },
  ]);
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "customer",
      sender: "USER",
      body: "Retry",
      clientTurnId: "turn",
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: true, replayed: true });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
  expect(prisma.supportCaseMessage.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { caseId: "case", seq: { gte: 2 }, isInternal: false },
    }),
  );
});
it("rejects a stale public reply instead of overwriting a concurrent resolution", async () => {
  (cases.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "staff",
      sender: "AGENT",
      body: "Reply",
      expectedLastMessageAt: now.toISOString(),
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: false, status: 409 });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
  expect(cases.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ status: "OPEN", updatedAt: now }),
    }),
  );
});
it("never exposes internal notes or assignment details to the customer", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      assignedToId: "private-staff",
      messages: [
        { id: "public", isInternal: false },
        { id: "private", isInternal: true },
      ],
      events: [{ kind: "ASSIGNED", note: "private" }],
    }),
  );
  const result = await readSupportCaseForViewer("case", {
    userId: "customer",
    role: "CONSULTEE",
    isStaff: false,
  });
  expect(result?.messages).toEqual([{ id: "public", isInternal: false }]);
  expect(result).toHaveProperty("assignedToId", null);
  expect(result?.events).toEqual([]);
});
it("hides organization-owned correspondence after membership removal", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      ownershipScope: "ORG_BILLING",
      organizationId: "org",
      submitterUserId: "customer",
    }),
  );
  (prisma.membership.findUnique as jest.Mock).mockResolvedValueOnce({
    role: "OWNER",
    status: "REMOVED",
  });
  expect(
    await readSupportCaseForViewer("case", {
      userId: "customer",
      role: "ORG_WORKSPACE",
      isStaff: false,
    }),
  ).toBeNull();
});
it("does not reveal external complainants through a personal case read", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ externalRequesterEmail: "private@example.test" }),
  );
  expect(
    await readSupportCaseForViewer("case", {
      userId: "customer",
      role: "CONSULTEE",
      isStaff: false,
    }),
  ).toBeNull();
});
it("rejects an expired CSAT without writing a rating", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      status: "RESOLVED",
      resolvedAt: new Date(now.getTime() - 29 * 86_400_000),
    }),
  );
  expect(
    await submitSupportCaseCsat(
      { caseId: "case", userId: "customer", rating: 5 },
      now,
    ),
  ).toMatchObject({ ok: false, status: 400 });
  expect(cases.updateMany).not.toHaveBeenCalled();
});
it("customer waiting time cannot postpone an urgent content deadline", () => {
  const deadline = supportDeadline("INTIMATE_CONTENT", now);
  expect(
    slaStateOf(
      {
        status: "IN_PROGRESS",
        ackDueAt: now,
        acknowledgedAt: now,
        resolutionDueAt: new Date(now.getTime() + 7 * 86_400_000),
        statutoryDueAt: deadline.statutoryDueAt,
        resolvedAt: null,
        awaitingUserSince: now,
        pausedSeconds: 0,
      },
      new Date(now.getTime() + 3 * 3_600_000),
    ),
  ).toMatchObject({ resolutionBreached: true });
});
it("monthly reporting uses category deadlines rather than subtracting waiting time", async () => {
  (cases.findMany as jest.Mock).mockResolvedValueOnce([
    record({
      acknowledgedAt: now,
      resolvedAt: new Date(now.getTime() + 3 * 3_600_000),
      statutoryDueAt: new Date(now.getTime() + 2 * 3_600_000),
    }),
  ]);
  expect(await supportMonthlyComplianceReport(2026, 10)).toMatchObject({
    received: 1,
    acknowledgedWithin24h: 1,
    resolvedWithinDeadline: 0,
  });
});

it("formal intake promotes an existing guided conversation into the human queue atomically", async () => {
  const guided = record({
    activeChannel: "SELF_SERVE",
    priority: "MEDIUM",
    messageSeq: 2,
  });
  (cases.findFirst as jest.Mock).mockResolvedValueOnce(guided);
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(guided);
  (cases.findUniqueOrThrow as jest.Mock)
    .mockResolvedValueOnce({ messageSeq: 2 })
    .mockResolvedValueOnce(guided)
    .mockResolvedValueOnce({
      ...guided,
      activeChannel: "HUMAN",
      receivedAt: now,
    });
  await createOrReuseSupportCase(
    {
      title: "Help",
      description: "Please investigate",
      category: "GENERAL",
      requesterUserId: "customer",
      submitterUserId: "customer",
      activeChannel: "HUMAN",
    },
    now,
  );
  expect(cases.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        activeChannel: "HUMAN",
        receivedAt: now,
        status: "OPEN",
      }),
    }),
  );
  expect(cases.create).not.toHaveBeenCalled();
});
