/** @jest-environment node */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  setTags: jest.fn(),
  setContext: jest.fn(),
  addBreadcrumb: jest.fn(),
  metrics: { count: jest.fn(), distribution: jest.fn() },
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock("next/headers", () => ({
  __esModule: true,
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

type User = { id: string; role: string; twoFactorEnabled?: boolean };
const mockAuth: { user: User | null; sessionCreatedAt: Date } = {
  user: null,
  sessionCreatedAt: new Date(),
};
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: async ({ allowUnenrolledOperator = false } = {}) => {
    const user = mockAuth.user;
    if (!user) return null;
    const operator = user.role === "ADMIN" || user.role === "STAFF";
    if (operator && user.twoFactorEnabled !== true && !allowUnenrolledOperator)
      return null;
    return {
      user: {
        banned: false,
        name: user.id,
        email: `${user.id}@x.test`,
        ...user,
      },
      session: {
        id: `s-${user.id}`,
        userId: user.id,
        createdAt: mockAuth.sessionCreatedAt,
      },
    };
  },
}));

jest.mock("../../lib/meetings/mirror-room-chat", () => ({
  __esModule: true,
  resolveCanonicalMeetingChannel: jest.fn(async () => ({
    channelType: "team",
    channelId: "webinar-web-1",
  })),
}));
jest.mock("../../lib/stream/support-intervention", () => ({
  __esModule: true,
  probeSupportChannel: jest.fn(async () => ({ exists: true, frozen: false })),
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
    id: args.dedupeKey,
  })),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
const mockAfter: (() => unknown)[] = [];
jest.mock("../../lib/api/after-safe", () => ({
  __esModule: true,
  scheduleAfter: (task: () => unknown) => {
    mockAfter.push(task);
    return Promise.resolve();
  },
}));

type Row = Record<string, unknown>;
const mockState: {
  case: Row;
  overdue: boolean;
  createError: unknown;
  writes: string[];
  grant: Row | null;
} = { case: {}, overdue: false, createError: null, writes: [], grant: null };

const mockDb = {
  supportCase: { findUnique: jest.fn(async () => mockState.case) },
  appointment: {
    findFirst: jest.fn(async () => ({
      id: "appt-1",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      appointmentType: "WEBINAR",
      organizationId: "org-sponsor",
      consultation: null,
      subscription: null,
      webinar: { id: "web-1", webinarPlan: { organizationId: null } },
      class: null,
    })),
    findMany: jest.fn(async () => [
      {
        id: "appt-1",
        participants: [{ userId: "u-host" }],
        consultation: null,
        subscription: null,
        webinar: {
          webinarPlan: { consultantProfileId: null, collaborators: [] },
        },
        class: null,
        payment: [{ hostOrganizationId: "org-host" }],
      },
    ]),
  },
  appointmentParticipant: {
    findMany: jest.fn(async () => [
      { userId: "u-learner" },
      { userId: "u-peer" },
    ]),
  },
  consultantProfile: { findMany: jest.fn(async () => []) },
  supportCaseEvidenceRequest: {
    findFirst: jest.fn(async () => (mockState.overdue ? { id: "ev-1" } : null)),
  },
  supportCaseChatAccess: {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => mockState.grant),
    updateMany: jest.fn(async () => {
      mockState.writes.push("grant.end");
      return { count: 1 };
    }),
    create: jest.fn(async (args: { data: Row }) => {
      if (mockState.createError) throw mockState.createError;
      mockState.writes.push("grant.create");
      return {
        id: "grant-1",
        grantedBy: null,
        endedAt: null,
        endReason: null,
        streamJoinedAt: null,
        streamLeftAt: null,
        ...args.data,
      };
    }),
  },
  supportCaseEvent: {
    create: jest.fn(async (args: { data: Row }) => {
      mockState.writes.push(`event.${String(args.data.kind)}`);
      return {};
    }),
  },
  orgAuditLog: {
    create: jest.fn(async (args: { data: Row }) => {
      mockState.writes.push(`orgAudit.${String(args.data.organizationId)}`);
      return {};
    }),
  },
  opsActionLog: {
    create: jest.fn(async () => {
      mockState.writes.push("opsAction");
      return { id: "ops" };
    }),
  },
  user: {
    findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id })),
    ),
  },
  membership: { findMany: jest.fn(async () => []) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "$transaction")
          return async (fn: (tx: unknown) => unknown) => fn(mockDb);
        return (mockDb as Record<string | symbol, unknown>)[prop];
      },
    },
  ),
  ALLOCATION_TX_MAX_WAIT_MS: 5000,
  ALLOCATION_TX_TIMEOUT_MS: 15000,
}));

import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import * as chatRoute from "../../app/api/support/cases/[caseId]/chat/route";
import {
  joinIntervention,
  leaveIntervention,
  probeSupportChannel,
} from "../../lib/stream/support-intervention";
import { syncSupportBoundary } from "../../lib/stream/support-boundary";

const callOrder = (fn: unknown) =>
  jest.mocked(fn as jest.Mock).mock.invocationCallOrder[0];

const USERS: Record<string, User> = {
  staff: { id: "u-staff", role: "STAFF", twoFactorEnabled: true },
  admin: { id: "u-admin", role: "ADMIN", twoFactorEnabled: true },
  staffNo2fa: { id: "u-staff2", role: "STAFF", twoFactorEnabled: false },
  consultee: { id: "u-learner", role: "CONSULTEE" },
  consultant: { id: "u-host", role: "CONSULTANT" },
};

function post(body: Row) {
  return chatRoute.POST(
    new NextRequest("https://app.test/api/support/cases/case-1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId: "case-1" }) },
  );
}

const READ = {
  action: "OPEN_READ",
  reason: "Learner reported abusive messages",
};
const INTERVENE = {
  action: "START_INTERVENTION",
  basis: "SAFETY",
  durationHours: 72,
  reason: "Learner reported a threat in chat",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAfter.length = 0;
  mockAuth.user = USERS.staff;
  mockAuth.sessionCreatedAt = new Date();
  mockState.case = {
    id: "case-1",
    referenceNumber: "FAM-2026-000001",
    title: "Help",
    status: "IN_PROGRESS",
    deletedAt: null,
    activeChannel: "HUMAN",
    appointmentId: "appt-1",
    category: "OTHER",
    requesterUserId: "u-learner",
    submitterUserId: "u-learner",
    organizationId: null,
    ownershipScope: "PERSONAL",
    externalRequesterEmail: null,
  };
  mockState.overdue = false;
  mockState.createError = null;
  mockState.writes = [];
  mockState.grant = null;
});

describe("authz", () => {
  it.each([
    ["staff", 201],
    ["admin", 201],
    ["consultee", 403],
    ["consultant", 403],
    ["staffNo2fa", 428],
  ])("OPEN_READ as %s → %s", async (persona, status) => {
    mockAuth.user = USERS[persona];
    const res = await post(READ);
    expect(res.status).toBe(status);
  });

  it("refuses anonymous callers", async () => {
    mockAuth.user = null;
    expect((await post(READ)).status).toBe(401);
  });

  it.each([READ, INTERVENE])(
    "requires a fresh session for $action",
    async (body) => {
      mockAuth.sessionCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      expect(mockDb.supportCaseChatAccess.create).not.toHaveBeenCalled();
    },
  );

  it("requires a reason of at least five characters", async () => {
    const res = await post({ ...READ, reason: "ok" });
    expect(res.status).toBe(400);
    expect(mockDb.supportCaseChatAccess.create).not.toHaveBeenCalled();
  });
});

describe("OPEN_READ", () => {
  it("writes the grant, its event, one OrgAuditLog per tenant and the ops row in one transaction", async () => {
    const res = await post(READ);
    expect(res.status).toBe(201);
    expect(mockState.writes).toEqual([
      "grant.create",
      "event.CHAT_ACCESS_GRANTED",
      "orgAudit.org-sponsor",
      "orgAudit.org-host",
      "opsAction",
    ]);
    const data = mockDb.supportCaseChatAccess.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      kind: "READ",
      basis: "OPEN_CASE",
      grantedById: "u-staff",
      channelType: "team",
      channelId: "webinar-web-1",
      withholdNotice: false,
    });
    expect((data.scopeUserIds as string[]).sort()).toEqual([
      "u-host",
      "u-learner",
    ]);
    expect(
      (data.expiresAt as Date).getTime() - (data.createdAt as Date).getTime(),
    ).toBe(24 * 3_600_000);
    // Org admins see that staff reviewed a booking chat, never the case or content.
    expect(mockDb.orgAuditLog.create.mock.calls[0][0].data).toEqual({
      organizationId: "org-sponsor",
      actorMembershipId: null,
      category: "SYSTEM",
      action: "SUPPORT_CHAT_REVIEWED",
      description: "Familiarise support reviewed a booking chat",
      details: { appointmentId: "appt-1", kind: "READ" },
    });
    expect(joinIntervention).not.toHaveBeenCalled();
    expect(probeSupportChannel).not.toHaveBeenCalled();
  });

  it("locks the channel after commit", async () => {
    await post(READ);
    expect(syncSupportBoundary).not.toHaveBeenCalled();
    expect(mockAfter).toHaveLength(1);
    await mockAfter[0]();
    expect(syncSupportBoundary).toHaveBeenCalledWith("team", "webinar-web-1");
    expect(joinIntervention).not.toHaveBeenCalled();
  });

  it("validates group targets against the live participants", async () => {
    const res = await post({ ...READ, targetUserIds: ["u-stranger"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "TARGET_NOT_PARTY" });
  });

  it.each([
    ["a resolved case", { status: "RESOLVED" }, 409, "CASE_NOT_OPEN"],
    ["a bot case", { activeChannel: "SELF_SERVE" }, 409, "CASE_NOT_HUMAN"],
    ["a case without a booking", { appointmentId: null }, 409, "NO_BOOKING"],
  ])("refuses %s", async (_label, patch, status, code) => {
    Object.assign(mockState.case, patch);
    const res = await post(READ);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(mockDb.supportCaseChatAccess.create).not.toHaveBeenCalled();
  });

  it("maps the one-live-read partial unique to READ_ACTIVE", async () => {
    mockState.createError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    const res = await post(READ);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "READ_ACTIVE" });
  });
});

describe("START_INTERVENTION", () => {
  it("refuses a frozen channel before opening the grant", async () => {
    jest
      .mocked(probeSupportChannel)
      .mockResolvedValueOnce({ exists: true, frozen: true });
    const res = await post(INTERVENE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CHANNEL_FROZEN" });
    expect(mockDb.supportCaseChatAccess.create).not.toHaveBeenCalled();
  });

  it("refuses a channel that was never started", async () => {
    jest.mocked(probeSupportChannel).mockResolvedValueOnce({ exists: false });
    const res = await post(INTERVENE);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "CHAT_NOT_FOUND" });
  });

  it("opens a 72-hour grant with an asserted safety basis and joins after commit", async () => {
    const res = await post(INTERVENE);
    expect(res.status).toBe(201);
    const data = mockDb.supportCaseChatAccess.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "INTERVENE", basis: "SAFETY" });
    expect(
      (data.expiresAt as Date).getTime() - (data.createdAt as Date).getTime(),
    ).toBe(72 * 3_600_000);
    expect(mockDb.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "support.chat.intervene.start",
          surface: "supportChat.intervene",
          reason: "Learner reported a threat in chat",
          after: expect.objectContaining({ basisSource: "ASSERTED" }),
        }),
      }),
    );
    expect(joinIntervention).not.toHaveBeenCalled();
    expect(mockAfter).toHaveLength(1);
    await mockAfter[0]();
    expect(joinIntervention).toHaveBeenCalledWith("grant-1");
    expect(syncSupportBoundary).toHaveBeenCalledWith("team", "webinar-web-1");
    expect(callOrder(syncSupportBoundary)).toBeLessThan(
      callOrder(joinIntervention),
    );
  });

  it("refuses an evidence-overdue basis when nothing is overdue", async () => {
    const res = await post({ ...INTERVENE, basis: "EVIDENCE_OVERDUE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "BASIS_NOT_MET" });
  });

  it("accepts an overdue evidence request as the basis", async () => {
    mockState.overdue = true;
    const res = await post({ ...INTERVENE, basis: "EVIDENCE_OVERDUE" });
    expect(res.status).toBe(201);
  });

  it("refuses a duration outside 24, 72 or 168 hours", async () => {
    const res = await post({ ...INTERVENE, durationHours: 48 });
    expect(res.status).toBe(400);
  });

  it("maps the one-seat-per-channel partial unique to INTERVENTION_ACTIVE", async () => {
    mockState.createError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    const res = await post(INTERVENE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INTERVENTION_ACTIVE" });
    expect(mockAfter).toHaveLength(0);
  });
});

describe("ending grants", () => {
  const live = {
    id: "grant-1",
    caseId: "case-1",
    kind: "INTERVENE",
    basis: "SAFETY",
    grantedById: "u-other-staff",
    grantedBy: null,
    channelType: "team",
    channelId: "webinar-web-1",
    scopeUserIds: ["u-learner"],
    windowStart: new Date(),
    organizationIds: [],
    withholdNotice: false,
    expiresAt: new Date(Date.now() + 3_600_000),
    endedAt: null,
    endReason: null,
    streamJoinedAt: new Date(),
    streamLeftAt: null,
    createdAt: new Date(),
  };

  it("any operator may end an intervention; the leave runs after commit", async () => {
    mockState.grant = live;
    const res = await post({
      action: "END_INTERVENTION",
      grantId: "grant-1",
      reason: "Evidence received, leaving the chat",
    });
    expect(res.status).toBe(200);
    expect(mockState.writes).toEqual([
      "grant.end",
      "event.CHAT_ACCESS_ENDED",
      "opsAction",
    ]);
    expect(leaveIntervention).not.toHaveBeenCalled();
    await mockAfter[0]();
    expect(leaveIntervention).toHaveBeenCalledWith("grant-1");
    expect(syncSupportBoundary).toHaveBeenCalledWith("team", "webinar-web-1");
    expect(callOrder(leaveIntervention)).toBeLessThan(
      callOrder(syncSupportBoundary),
    );
  });

  it("ending a READ unlocks the channel after commit", async () => {
    mockState.grant = { ...live, kind: "READ", grantedById: "u-staff" };
    const res = await post({
      action: "END_READ",
      grantId: "grant-1",
      reason: "Done reviewing the chat",
    });
    expect(res.status).toBe(200);
    expect(syncSupportBoundary).not.toHaveBeenCalled();
    expect(mockAfter).toHaveLength(1);
    await mockAfter[0]();
    expect(syncSupportBoundary).toHaveBeenCalledWith("team", "webinar-web-1");
    expect(leaveIntervention).not.toHaveBeenCalled();
  });

  it("an already-ended grant answers 410", async () => {
    mockState.grant = { ...live, endedAt: new Date(), endReason: "EXPIRED" };
    const res = await post({
      action: "END_INTERVENTION",
      grantId: "grant-1",
      reason: "Leaving the chat now",
    });
    expect(res.status).toBe(410);
  });

  it("a READ is ended only by the operator who opened it", async () => {
    await post({
      action: "END_READ",
      grantId: "grant-1",
      reason: "Done reviewing the chat",
    });
    expect(mockDb.supportCaseChatAccess.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "READ",
          grantedById: "u-staff",
        }),
      }),
    );
  });
});

describe("GET status", () => {
  it("is staff-only", async () => {
    mockAuth.user = USERS.consultee;
    const res = await chatRoute.GET(
      new NextRequest("https://app.test/api/support/cases/case-1/chat"),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("returns eligibility, parties and verified bases for staff", async () => {
    mockState.case.category = "SAFETY_CONCERN";
    const res = await chatRoute.GET(
      new NextRequest("https://app.test/api/support/cases/case-1/chat"),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      channel: { type: "team", kind: "GROUP" },
      read: { ok: true },
      intervene: { ok: true, verifiedBases: ["SAFETY", "FRAUD_OR_SCAM"] },
      requiresTargets: false,
      canIntervene: true,
    });
  });
});
