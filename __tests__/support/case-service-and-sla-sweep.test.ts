/**
 * @jest-environment node
 */

const mockStageBell = jest.fn<Promise<{ id: string }>, unknown[]>(async () => ({
  id: "outbox-1",
}));
const mockNotifyTicketUpdate = jest.fn<Promise<{ status: string }>, unknown[]>(
  async () => ({ status: "sent" }),
);
const mockNotifyTicketResponse = jest.fn<
  Promise<{ status: string }>,
  unknown[]
>(async () => ({ status: "sent" }));
const mockDeliver = jest.fn<
  Promise<{ success: boolean; staged: boolean; data: { id: string } }>,
  unknown[]
>(async () => ({
  success: true,
  staged: true,
  data: { id: "email-1" },
}));
const mockSendTicketUpdateEmail = jest.fn<
  Promise<{ success: boolean }>,
  unknown[]
>(async () => ({ success: true }));
const mockReportSentryError = jest.fn<void, unknown[]>();

jest.mock("../../lib/rate-limit", () => ({
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    async (_job: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockStageBell(...args),
}));

jest.mock("../../lib/novu", () => ({
  notifySupportTicketUpdate: (...args: unknown[]) =>
    mockNotifyTicketUpdate(...args),
  notifySupportTicketResponse: (...args: unknown[]) =>
    mockNotifyTicketResponse(...args),
}));

jest.mock("../../lib/email", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
  sendSupportTicketUpdateEmail: (...args: unknown[]) =>
    mockSendTicketUpdateEmail(...args),
  sendSupportTicketResponseEmail: jest.fn(async () => ({ success: true })),
  DEFAULT_FROM_ADDRESS: "Familiarise Support <support@mail.familiarisenow.com>",
  EMAIL_BUDGET_MS: { REQUEST: 5000, JOB: 10000, AUTH: 8000 },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));

const mockRequireApiAuth = jest.fn<
  Promise<
    | {
        session: {
          user: {
            id: string;
            name: string;
            role: string;
            twoFactorEnabled?: boolean;
          };
        };
      }
    | { error: Response }
  >,
  unknown[]
>(async () => ({
  session: { user: { id: "user-1", name: "User One", role: "USER" } },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requirePrivilegedAuth: jest.fn(async () => ({
    session: { user: { id: "staff-1", name: "Operator One", role: "STAFF" } },
  })),
  requireAdminAuth: jest.fn(async () => ({
    session: { user: { id: "admin-1", name: "Admin One", role: "ADMIN" } },
  })),
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
  requireApiSession: jest.fn(async () => ({
    session: { user: { id: "user-1", name: "User One", role: "USER" } },
  })),
  isPrivileged: (r?: string) => r === "ADMIN" || r === "STAFF",
}));

jest.mock("../../lib/prisma", () => {
  const tx = {
    supportTicketCounter: {
      upsert: jest.fn(),
    },
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
    supportCaseSubject: {
      findFirst: jest.fn(),
    },
    supportCaseEvent: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    supportTicket: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    supportResponse: {
      create: jest.fn(),
    },
    appointmentSupportThread: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    supportMessage: {
      create: jest.fn(),
    },
    notificationOutbox: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    membership: {
      findFirst: jest.fn(),
    },
    appointment: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(async () => ({ role: "STAFF" })),
      findMany: jest.fn(),
    },
  };

  const client = {
    ...tx,
    $transaction: jest.fn(),
    supportFlowOutcome: {
      create: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    dispute: {
      findMany: jest.fn(),
    },
  };
  client.$transaction.mockImplementation(
    async (cb: (arg: typeof client) => Promise<unknown>) => cb(client),
  );

  return {
    __esModule: true,
    default: client,
    ALLOCATION_TX_MAX_WAIT_MS: 5000,
    ALLOCATION_TX_TIMEOUT_MS: 10000,
  };
});

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";

interface MockPrismaClient {
  supportTicketCounter: { upsert: jest.Mock };
  supportCase: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
  supportCaseMessage: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
  };
  supportCaseSubject: { findFirst: jest.Mock };
  supportCaseEvent: { findFirst: jest.Mock; create: jest.Mock };
  supportTicket: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  supportResponse: { create: jest.Mock };
  appointmentSupportThread: { findUnique: jest.Mock; updateMany: jest.Mock };
  supportMessage: { create: jest.Mock };
  notificationOutbox: { findUnique: jest.Mock; findMany: jest.Mock };
  membership: { findFirst: jest.Mock };
  appointment: { findUnique: jest.Mock };
  $transaction: jest.Mock;
  supportFlowOutcome: {
    create: jest.Mock;
    updateMany: jest.Mock;
    groupBy: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
  };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  dispute: { findMany: jest.Mock };
}

const mockPrisma = jest.requireMock<{ default: MockPrismaClient }>(
  "../../lib/prisma",
).default;
const mockTx = mockPrisma;

import {
  ACK_PROMISE_COPY,
  slaDeadlinesFor,
  tightenDeadlinesForPriorityRaise,
} from "../../lib/support/sla";
import { allocateTicketReference } from "../../lib/support/reference";
import {
  deflectionSince,
  rateFlowOutcome,
  recordFlowOutcome,
  supportHealthMetrics,
} from "../../lib/support/deflection";
import {
  CALLBACK_WINDOWS,
  CallbackWindowSchema,
  CreateSupportCaseInputSchema,
  SupportCaseValidationError,
  appendSupportCaseTurn,
  createOrReuseSupportCase,
  patchSupportCaseLifecycle,
  readSupportCaseForViewer,
  submitSupportCaseCsat,
  supportMonthlyComplianceReport,
} from "../../lib/support/case-service";
import { readOwnTicket } from "../../lib/support/own-case-read";
import { runSupportSlaSweep } from "../../lib/support/sla-sweep";
import {
  GET as getCases,
  POST as postCases,
} from "../../app/api/support/cases/route";
import { GET as getCaseDetail } from "../../app/api/support/cases/[caseId]/route";
import { POST as postCaseMessage } from "../../app/api/support/cases/[caseId]/messages/route";
import { PATCH as patchStaffTicket } from "../../app/api/staff/support-tickets/[ticketId]/route";
import { POST as postStaffTicketResponse } from "../../app/api/staff/support-tickets/[ticketId]/responses/route";

describe("WS1/WS2/WS4/WS6/WS9 Support Backend & SLA Engine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireApiAuth.mockResolvedValue({
      session: { user: { id: "user-1", name: "User One", role: "USER" } },
    });
    mockPrisma.supportTicketCounter.upsert.mockReset();
    mockPrisma.supportCase.findUnique.mockReset();
    mockPrisma.supportCase.findUniqueOrThrow.mockReset();
    mockPrisma.supportCase.findFirst.mockReset();
    mockPrisma.supportCase.findMany.mockReset();
    mockPrisma.supportCase.create.mockReset();
    mockPrisma.supportCase.updateMany.mockReset();
    mockPrisma.supportCaseMessage.findUnique.mockReset();
    mockPrisma.supportCaseMessage.findMany.mockReset();
    mockPrisma.supportCaseMessage.create.mockReset();
    mockPrisma.supportCaseEvent.findFirst.mockReset();
    mockPrisma.supportCaseEvent.create.mockReset();
    mockPrisma.supportTicket.findUnique.mockReset();
    mockPrisma.supportTicket.findUniqueOrThrow.mockReset();
    mockPrisma.supportTicket.findMany.mockReset();
    mockPrisma.supportTicket.updateMany.mockReset();
    mockPrisma.supportResponse.create.mockReset();
    mockPrisma.appointmentSupportThread.findUnique.mockReset();
    mockPrisma.appointmentSupportThread.updateMany.mockReset();
    mockPrisma.supportMessage.create.mockReset();
    mockPrisma.notificationOutbox.findUnique.mockReset();
    mockPrisma.notificationOutbox.findMany.mockReset();
    mockPrisma.notificationOutbox.findMany.mockResolvedValue([]);
    mockPrisma.membership.findFirst.mockReset();
    mockPrisma.appointment.findUnique.mockReset();
    mockPrisma.supportFlowOutcome.create.mockReset();
    mockPrisma.supportFlowOutcome.updateMany.mockReset();
    mockPrisma.supportFlowOutcome.groupBy.mockReset();
    mockPrisma.supportFlowOutcome.findMany.mockReset();
    mockPrisma.supportFlowOutcome.findFirst.mockReset();
    mockPrisma.user.findUnique.mockReset();
    mockPrisma.user.findMany.mockReset();
    mockPrisma.dispute.findMany.mockReset();
    mockPrisma.$transaction.mockImplementation(
      async (cb: (arg: typeof mockPrisma) => Promise<unknown>) =>
        cb(mockPrisma),
    );
  });

  it("exports ACK_PROMISE_COPY and only tightens SLA deadlines on priority raise", () => {
    expect(ACK_PROMISE_COPY).toBe("within 24 hours");

    const openedAt = new Date("2026-10-10T00:00:00.000Z");
    const initial = slaDeadlinesFor("LOW", openedAt);
    const now = new Date("2026-10-10T01:00:00.000Z");

    const raised = tightenDeadlinesForPriorityRaise(
      {
        priority: "LOW",
        ackDueAt: initial.ackDueAt,
        acknowledgedAt: null,
        resolutionDueAt: initial.resolutionDueAt,
        resolvedAt: null,
      },
      "URGENT",
      now,
    );
    expect(raised.ackDueAt?.toISOString()).toBe("2026-10-10T03:00:00.000Z");
    expect(raised.resolutionDueAt?.toISOString()).toBe(
      "2026-10-11T01:00:00.000Z",
    );

    const lowered = tightenDeadlinesForPriorityRaise(
      {
        priority: "URGENT",
        ackDueAt: new Date("2026-10-10T02:00:00.000Z"),
        acknowledgedAt: null,
        resolutionDueAt: new Date("2026-10-11T00:00:00.000Z"),
        resolvedAt: null,
      },
      "LOW",
      now,
    );
    expect(lowered).toEqual({});
  });

  it("allocates FAM-YYYY-NNNNNN using IST calendar year across Jan 1 00:00–05:30 IST", async () => {
    mockTx.supportTicketCounter.upsert.mockResolvedValueOnce({ nextSeq: 2 });
    // 2026-12-31T20:00:00Z is 2027-01-01T01:30:00 IST
    const ref = await allocateTicketReference(
      mockTx as never,
      new Date("2026-12-31T20:00:00.000Z"),
    );
    expect(ref).toBe("FAM-2027-000001");
    expect(mockTx.supportTicketCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { year: 2027 },
      }),
    );
  });

  it("returns outcomeId on recordFlowOutcome, CAS-guards helpfulRating, and computes 7d re-contact rate", async () => {
    mockPrisma.supportFlowOutcome.create.mockResolvedValueOnce({
      id: "outcome-abc",
    });
    const outcomeId = await recordFlowOutcome({
      scope: "PLATFORM",
      flowKey: "billing",
      outcome: "RESOLVED",
      userId: "user-1",
    });
    expect(outcomeId).toBe("outcome-abc");

    mockPrisma.supportFlowOutcome.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    const firstRate = await rateFlowOutcome("outcome-abc", "user-1", 5);
    expect(firstRate).toEqual({ updated: true });
    expect(mockPrisma.supportFlowOutcome.updateMany).toHaveBeenCalledWith({
      where: { id: "outcome-abc", userId: "user-1", helpfulRating: null },
      data: { helpfulRating: 5 },
    });

    mockPrisma.supportFlowOutcome.groupBy.mockResolvedValueOnce([
      { outcome: "RESOLVED", _count: { _all: 2 } },
      { outcome: "ESCALATED", _count: { _all: 2 } },
    ]);
    const t0 = new Date("2026-10-01T00:00:00.000Z");
    mockPrisma.supportFlowOutcome.findMany
      .mockResolvedValueOnce([
        { id: "o-1", userId: "u-1", createdAt: t0 },
        { id: "o-2", userId: "u-2", createdAt: t0 },
      ])
      .mockResolvedValueOnce([]);
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([
      {
        requesterUserId: "u-1",
        createdAt: new Date("2026-10-03T00:00:00.000Z"),
      },
    ]);
    mockPrisma.supportTicket.findMany.mockResolvedValueOnce([]);

    const summary = await deflectionSince(new Date("2026-09-30T00:00:00.000Z"));
    expect(summary).toEqual({
      resolved: 2,
      escalated: 2,
      total: 4,
      deflectionRate: 50,
      resolvedUsers: 2,
      recontactedUsers: 1,
      recontactRate7d: 50,
    });
  });

  it("dedupes createOrReuseSupportCase on submitter-scoped clientIntakeId and appends USER turn on open scope", async () => {
    expect(
      CreateSupportCaseInputSchema.safeParse({
        title: "Missing category and flowKey",
        description: "Body",
        requesterUserId: "u-1",
        submitterUserId: "u-1",
      }).success,
    ).toBe(false);
    expect(
      CreateSupportCaseInputSchema.safeParse({
        title: "Occurrence without appointment",
        description: "Body",
        category: "REFUND",
        appointmentOccurrenceId: "occ-1",
        requesterUserId: "u-1",
        submitterUserId: "u-1",
      }).success,
    ).toBe(false);

    mockTx.supportCase.findFirst.mockResolvedValueOnce({
      id: "case-existing",
      referenceNumber: "FAM-2026-000042",
    });
    const replay = await createOrReuseSupportCase({
      title: "Duplicate",
      description: "Body",
      category: "GENERAL",
      requesterUserId: "u-1",
      submitterUserId: "u-1",
      clientIntakeId: "intake-xyz",
    });
    expect(replay.reused).toBe(true);
    expect(replay.dedupeReason).toBe("client_intake_id");
    expect(mockTx.supportCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientIntakeId: "intake-xyz",
          submitterUserId: "u-1",
        },
      }),
    );
    expect(mockTx.supportCase.create).not.toHaveBeenCalled();

    const now = new Date("2026-10-10T12:00:00.000Z");
    const awaitingSince = new Date("2026-10-10T11:59:00.000Z");
    mockTx.supportCase.findFirst.mockResolvedValueOnce({
      id: "case-open-scope",
      referenceNumber: "FAM-2026-000043",
      status: "RESOLVED",
      assignedToId: "staff-1",
      messageSeq: 2,
      awaitingUserSince: awaitingSince,
      pausedSeconds: 10,
      messages: [],
      subjects: [],
      events: [],
    });
    mockTx.supportCase.updateMany.mockResolvedValueOnce({ count: 1 });
    mockTx.supportCaseMessage.create.mockResolvedValueOnce({
      id: "msg-new",
      seq: 3,
      sender: "USER",
      body: "Need refund",
    });
    mockTx.supportCaseEvent.create.mockResolvedValueOnce({ id: "evt-reopen" });
    mockTx.supportCase.findUnique.mockResolvedValueOnce(null);

    const openScope = await createOrReuseSupportCase(
      {
        title: "Cancel booking",
        description: "Need refund",
        requesterUserId: "u-1",
        submitterUserId: "u-1",
        appointmentId: "apt-1",
        category: "REFUND",
      },
      now,
    );
    expect(openScope.reused).toBe(true);
    expect(openScope.dedupeReason).toBe("open_scope");
    expect(mockTx.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "case-open-scope",
          status: "RESOLVED",
        }),
        data: expect.objectContaining({
          status: "IN_PROGRESS",
          messageSeq: { increment: 1 },
          lastMessageAt: now,
          pausedSeconds: 70,
          awaitingUserSince: null,
        }),
      }),
    );
    expect(mockTx.supportCaseMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: "case-open-scope",
          seq: 3,
          sender: "USER",
          body: "Need refund",
        }),
      }),
    );
  });

  it("appendSupportCaseTurn replays stored messages on duplicate clientTurnId with isInternal: false filter for non-staff", async () => {
    mockTx.supportCaseMessage.findUnique.mockResolvedValueOnce({ seq: 3 });
    mockTx.supportCaseMessage.findMany.mockResolvedValueOnce([
      { id: "m-3", seq: 3, sender: "USER", body: "Hello" },
      { id: "m-4", seq: 4, sender: "BOT", body: "Hi!" },
    ]);

    const res = await appendSupportCaseTurn({
      caseId: "case-1",
      sender: "USER",
      body: "Hello",
      isInternal: false,
      clientTurnId: "turn-retry-1",
    });
    expect(res).toEqual({
      ok: true,
      replayed: true,
      messages: [
        { id: "m-3", seq: 3, sender: "USER", body: "Hello" },
        { id: "m-4", seq: 4, sender: "BOT", body: "Hi!" },
      ],
    });
    expect(mockTx.supportCaseMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isInternal: false }),
      }),
    );
    expect(mockTx.supportCaseMessage.create).not.toHaveBeenCalled();
  });

  it("patchSupportCaseLifecycle cascades RESOLVED problem to open incidents and ADR 20 redacts member views on both detail and list", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    mockTx.supportCase.findUnique.mockResolvedValueOnce({
      id: "prob-1",
      referenceNumber: "FAM-2026-000100",
      status: "IN_PROGRESS",
      priority: "HIGH",
      caseKind: "PROBLEM",
      assignedToId: "staff-1",
      problemCaseId: null,
      resolvedAt: null,
      ackDueAt: now,
      acknowledgedAt: now,
      resolutionDueAt: now,
    });
    mockTx.supportCase.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockTx.supportCase.findMany.mockResolvedValueOnce([
      { id: "inc-1", status: "OPEN", messageSeq: 2 },
    ]);
    mockTx.supportCase.findUniqueOrThrow.mockResolvedValueOnce({
      id: "prob-1",
      referenceNumber: "FAM-2026-000100",
      status: "RESOLVED",
      messages: [],
      subjects: [],
      events: [],
    });

    const patched = await patchSupportCaseLifecycle(
      {
        caseId: "prob-1",
        actorId: "staff-1",
        expectedUpdatedAt: now.toISOString(),
        status: "RESOLVED",
        closingMessage: "Outage resolved for all affected bookings.",
      },
      now,
    );
    expect(patched.ok).toBe(true);
    expect(mockTx.supportCaseMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: "inc-1",
          seq: 3,
          body: "Outage resolved for all affected bookings.",
        }),
      }),
    );

    mockTx.supportCase.findUnique.mockResolvedValueOnce({
      id: "org-case-1",
      referenceNumber: "FAM-2026-000200",
      status: "OPEN",
      category: "SPONSORSHIP_BILLING",
      createdAt: now,
      organizationId: "org-1",
      requesterUserId: "member-1",
      submitterUserId: "org-admin-1",
      deletedAt: null,
      messages: [
        {
          id: "msg-secret",
          body: "Confidential operator note",
          isInternal: false,
        },
      ],
      subjects: [],
      events: [],
    });

    const memberView = await readSupportCaseForViewer("org-case-1", {
      userId: "member-1",
      isStaff: false,
    });
    expect(memberView).toEqual({
      id: "org-case-1",
      referenceNumber: "FAM-2026-000200",
      status: "OPEN",
      category: "SPONSORSHIP_BILLING",
      createdAt: now,
      organizationId: "org-1",
      requesterUserId: "member-1",
      submitterUserId: null,
      title: "Organization support request",
      description: "",
      subjects: [],
      events: [],
      messages: [],
      filedByOrganizationNotice: true,
    });

    mockPrisma.supportCase.findMany.mockResolvedValueOnce([
      {
        id: "org-case-1",
        referenceNumber: "FAM-2026-000200",
        title: "Secret HR Escalation Title",
        category: "SPONSORSHIP_BILLING",
        priority: "HIGH",
        status: "OPEN",
        caseKind: "INCIDENT",
        requesterUserId: "user-1",
        submitterUserId: "org-admin-1",
        organizationId: "org-1",
        appointmentId: null,
        appointmentOccurrenceId: null,
        callbackPhone: "+919999999999",
        callbackWindow: "10am-12pm",
        ackDueAt: now,
        acknowledgedAt: null,
        resolutionDueAt: now,
        resolvedAt: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const listRes = await getCases(
      new NextRequest("https://familiarise.com/api/support/cases"),
    );
    const listJson = await listRes.json();
    expect(listJson.data[0]).toMatchObject({
      title: "Organization support request",
      callbackPhone: null,
      callbackWindow: null,
      filedByOrganizationNotice: true,
    });

    const forbiddenPost = await postCases(
      new NextRequest("https://familiarise.com/api/support/cases", {
        method: "POST",
        body: JSON.stringify({
          title: "Impersonated",
          description: "Unauthorized filing",
          category: "GENERAL",
          requesterUserId: "other-user",
        }),
      }),
    );
    expect(forbiddenPost.status).toBe(403);
  });

  it("submitSupportCaseCsat validates 28d window and records CSAT_RATED event on both SupportCase and legacy SupportTicket", async () => {
    const resolvedAt = new Date("2026-10-01T00:00:00.000Z");
    mockTx.supportCase.findUnique.mockResolvedValueOnce({
      id: "case-csat",
      requesterUserId: "user-1",
      submitterUserId: "user-1",
      status: "RESOLVED",
      resolvedAt,
    });
    mockTx.supportCase.updateMany.mockResolvedValueOnce({ count: 1 });

    const rated = await submitSupportCaseCsat(
      { caseId: "case-csat", userId: "user-1", rating: 5 },
      new Date("2026-10-05T00:00:00.000Z"),
    );
    expect(rated.ok).toBe(true);
    expect(mockTx.supportCaseEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: "case-csat",
          kind: "CSAT_RATED",
          toValue: "5",
        }),
      }),
    );

    mockTx.supportCase.findUnique.mockResolvedValueOnce(null);
    mockTx.supportTicket.findUnique.mockResolvedValueOnce({
      id: "legacy-t-1",
      userId: "user-1",
      status: "RESOLVED",
      resolvedAt,
    });
    mockTx.supportCaseEvent.findFirst.mockResolvedValueOnce(null);

    const legacyRated = await submitSupportCaseCsat(
      { caseId: "legacy-t-1", userId: "user-1", rating: 4 },
      new Date("2026-10-05T00:00:00.000Z"),
    );
    expect(legacyRated.ok).toBe(true);
    expect(mockTx.supportCaseEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legacyTicketId: "legacy-t-1",
          actorId: "user-1",
          kind: "CSAT_RATED",
          toValue: "4",
        }),
      }),
    );
  });

  it("supportMonthlyComplianceReport and supportHealthMetrics compute exact metrics including unacked >24h misses", async () => {
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([
      {
        id: "c-1",
        referenceNumber: "FAM-2026-000010",
        title: "General grievance without moderation report",
        description: "Billing issue",
        category: "GRIEVANCE",
        status: "RESOLVED",
        createdAt: new Date("2026-10-01T01:00:00.000Z"),
        acknowledgedAt: new Date("2026-10-01T05:00:00.000Z"),
        resolvedAt: new Date("2026-10-03T01:00:00.000Z"),
        pausedSeconds: 0,
      },
      {
        id: "c-2",
        referenceNumber: "FAM-2026-000011",
        title: "Appeal of RPT-2026-000042 decision",
        description: "Contesting RPT-2026-000042 outcome",
        category: "GRIEVANCE",
        status: "RESOLVED",
        createdAt: new Date("2026-10-02T01:00:00.000Z"),
        acknowledgedAt: new Date("2026-10-02T04:00:00.000Z"),
        resolvedAt: new Date("2026-10-04T01:00:00.000Z"),
        pausedSeconds: 0,
      },
    ]);
    mockPrisma.supportTicket.findMany.mockResolvedValueOnce([]);

    const report = await supportMonthlyComplianceReport(2026, 10);
    expect(report).toMatchObject({
      received: 2,
      acknowledgedWithin24h: 2,
      disposedWithin15d: 2,
      grievances: 2,
      appealed: 1,
    });

    mockPrisma.supportFlowOutcome.groupBy.mockResolvedValueOnce([]);
    mockPrisma.supportFlowOutcome.findMany.mockResolvedValueOnce([]);
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([
      {
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        acknowledgedAt: new Date("2026-10-01T02:00:00.000Z"),
        resolvedAt: null,
        pausedSeconds: 0,
        firstAgentReplyAt: null,
        csatRating: null,
      },
      {
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        acknowledgedAt: null,
        resolvedAt: null,
        pausedSeconds: 0,
        firstAgentReplyAt: null,
        csatRating: null,
      },
    ]);
    mockPrisma.supportTicket.findMany.mockResolvedValueOnce([]);

    const health = await supportHealthMetrics(
      new Date("2026-09-30T00:00:00.000Z"),
      new Date("2026-10-05T00:00:00.000Z"),
    );
    expect(health.ackWithin24hRate).toBe(50);
  });

  it("runSupportSlaSweep stages SLA notices, escapes HTML, separates warn/breach candidates, suppresses duplicate email sends on existing outbox dedupeKey, auto-closes >28d, and alerts disputes", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: "admin-1", email: "admin@test.com", name: "Admin", role: "ADMIN" },
    ]);
    mockPrisma.supportTicket.findMany
      .mockResolvedValueOnce([
        {
          id: "t-breach",
          referenceNumber: "FAM-2026-000500",
          title: "Breached <script>Org</script> Ticket",
          status: "OPEN",
          assignedToId: null,
          ackDueAt: new Date("2026-10-10T10:00:00.000Z"),
          acknowledgedAt: null,
          resolutionDueAt: new Date("2026-10-20T00:00:00.000Z"),
          resolvedAt: null,
          awaitingUserSince: null,
          pausedSeconds: 0,
          organization: {
            name: "Acme Org",
            escalationContactEmail: "sla@acme.org",
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "t-stale" }]);
    mockPrisma.supportCase.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.notificationOutbox.findUnique.mockResolvedValue(null);
    mockTx.supportTicket.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.dispute.findMany.mockResolvedValueOnce([
      {
        id: "disp-1",
        disputeId: "disp_rzp_1",
        amountPaise: 50_000,
        currency: "INR",
        reason: "fraudulent",
        dueBy: new Date("2026-10-11T06:00:00.000Z"),
      },
    ]);

    const res = await runSupportSlaSweep({ now, limit: 25 });
    expect(res).toMatchObject({
      success: true,
      slaNoticesStaged: 1,
      orgEscalationEmailsSent: 1,
      autoClosedCount: 1,
      disputeNoticesStaged: 1,
      errors: [],
    });
    expect(mockStageBell).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        dedupeKey: "sla:t-breach:ack:breach",
      }),
    );
    expect(mockStageBell).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        dedupeKey: "dispute-due:disp-1:24",
      }),
    );
    expect(mockDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@test.com",
        html: expect.stringContaining("&lt;script&gt;Org&lt;/script&gt;"),
      }),
      "support-sla-alert",
      expect.objectContaining({ entityRef: "sla:t-breach:ack:breach" }),
    );
    expect(mockDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ to: "sla@acme.org" }),
      "support-sla-alert-org",
      expect.objectContaining({ entityRef: "sla:t-breach:ack:breach" }),
    );
    expect(mockReportSentryError).not.toHaveBeenCalled();
  });

  it("staff ticket PATCH skips customer email/bell on priority-only change and staff response POST returns 409 on expectedLastMessageAt collision", async () => {
    const now = new Date("2026-10-10T10:00:00.000Z");
    mockTx.supportTicket.findUnique.mockResolvedValueOnce({
      id: "t-1",
      status: "OPEN",
      priority: "LOW",
      assignedToId: null,
      ackDueAt: new Date("2026-10-11T10:00:00.000Z"),
      acknowledgedAt: null,
      resolutionDueAt: new Date("2026-10-25T10:00:00.000Z"),
      resolvedAt: null,
      updatedAt: now,
    });
    mockTx.supportTicket.updateMany.mockResolvedValueOnce({ count: 1 });
    mockTx.supportTicket.findUniqueOrThrow.mockResolvedValueOnce({
      id: "t-1",
      status: "OPEN",
      priority: "HIGH",
      referenceNumber: "FAM-2026-000001",
      title: "Issue",
      organizationId: null,
      user: { id: "user-1", name: "User", email: "user@test.com" },
      appointmentSupportThread: null,
    });

    const patchReq = new NextRequest(
      "https://familiarise.com/api/staff/support-tickets/t-1",
      {
        method: "PATCH",
        body: JSON.stringify({
          priority: "HIGH",
          expectedUpdatedAt: now.toISOString(),
        }),
      },
    );
    const patchRes = await patchStaffTicket(patchReq, {
      params: Promise.resolve({ ticketId: "t-1" }),
    });
    expect(patchRes.status).toBe(200);
    expect(mockNotifyTicketUpdate).not.toHaveBeenCalled();
    expect(mockSendTicketUpdateEmail).not.toHaveBeenCalled();

    mockTx.supportTicket.findUnique.mockResolvedValueOnce({
      id: "t-1",
      status: "IN_PROGRESS",
      lastMessageAt: new Date("2026-10-10T10:05:00.000Z"),
      appointmentSupportThread: null,
    });
    const replyReq = new NextRequest(
      "https://familiarise.com/api/staff/support-tickets/t-1/responses",
      {
        method: "POST",
        body: JSON.stringify({
          message: "Agent reply",
          isInternal: false,
          expectedLastMessageAt: "2026-10-10T10:01:00.000Z",
        }),
      },
    );
    const replyRes = await postStaffTicketResponse(replyReq, {
      params: Promise.resolve({ ticketId: "t-1" }),
    });
    expect(replyRes.status).toBe(409);
    const body = await replyRes.json();
    expect(body.code).toBe("NEW_CUSTOMER_MESSAGE");
  });

  it("AST/regex audit: every single-notifier call across lib/support and lib/moderation passes an explicit dedupeKey argument", () => {
    const root = process.cwd();
    const novuSrc = fs.readFileSync(
      path.join(root, "lib/novu/service.ts"),
      "utf8",
    );
    const singleNotifiers = new Set<string>();
    const defRe = /export const (\w+)\s*=\s*define(?:Zoned)?SingleNotifier/g;
    for (const m of novuSrc.matchAll(defRe)) {
      singleNotifiers.add(m[1]);
    }
    expect(singleNotifiers.size).toBeGreaterThan(0);

    const scanDirs = ["lib/support", "lib/moderation"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          files.push(full);
        }
      }
    };
    for (const d of scanDirs) walk(path.join(root, d));

    const missingDedupeKey: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          singleNotifiers.has(node.expression.text)
        ) {
          if (node.arguments.length < 3) {
            const line =
              sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            missingDedupeKey.push(
              `${path.relative(root, file)}:${line} (${node.expression.text})`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(missingDedupeKey).toEqual([]);
  });

  it("recovers from Prisma P2002 unique constraint race on clientIntakeId and enforces occurrence belonging + viewer redaction on POST /api/support/cases", async () => {
    const { Prisma } = await import("@prisma/client");
    mockPrisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    );
    mockPrisma.supportCase.findFirst.mockResolvedValueOnce({
      id: "case-winner",
      referenceNumber: "FAM-2026-000999",
      submitterUserId: "u-1",
      requesterUserId: "u-1",
      status: "OPEN",
      subjects: [],
      messages: [],
      events: [],
    });

    const recovered = await createOrReuseSupportCase({
      title: "Race submission",
      description: "Body",
      category: "GENERAL",
      requesterUserId: "u-1",
      submitterUserId: "u-1",
      clientIntakeId: "intake-race-1",
    });
    expect(recovered.reused).toBe(true);
    expect(recovered.dedupeReason).toBe("client_intake_id");
    expect(recovered.supportCase.id).toBe("case-winner");

    mockPrisma.appointment.findUnique.mockResolvedValueOnce({
      id: "apt-1",
      organizationId: null,
      participants: [{ userId: "user-1", organizationId: null }],
      payment: [],
      occurrences: [],
    });
    const mismatchedOccRes = await postCases(
      new NextRequest("https://familiarise.com/api/support/cases", {
        method: "POST",
        body: JSON.stringify({
          title: "Session help",
          description: "Audio drop",
          category: "TECHNICAL",
          appointmentId: "apt-1",
          appointmentOccurrenceId: "occ-other-apt",
        }),
      }),
    );
    expect(mismatchedOccRes.status).toBe(400);

    const now = new Date("2026-10-10T12:00:00.000Z");
    mockPrisma.notificationOutbox.findMany.mockResolvedValueOnce([
      {
        transactionId: "tx-old",
        entityRef: "sla:old-ticket-1:ack:breach",
        payload: { ticketId: "old-ticket-1", activity: "sla-ack-breach" },
      },
    ]);
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    mockPrisma.supportTicket.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.supportCase.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.dispute.findMany.mockResolvedValueOnce([]);

    await runSupportSlaSweep({ now, limit: 10 });
    expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              acknowledgedAt: null,
              id: { notIn: ["old-ticket-1"] },
            }),
          ]),
        }),
      }),
    );
  });

  test("patchSupportCaseLifecycle banks awaitingUserSince into pausedSeconds on status change", async () => {
    const { patchSupportCaseLifecycle } =
      await import("../../lib/support/case-service");
    const now = new Date("2026-10-10T12:00:00.000Z");
    const updatedAt = new Date("2026-10-10T11:00:00.000Z");
    const awaitingSince = new Date("2026-10-10T11:30:00.000Z"); // 1800s ago
    mockPrisma.supportCase.findUnique.mockResolvedValueOnce({
      id: "case-pause-1",
      caseKind: "INCIDENT",
      status: "IN_PROGRESS",
      priority: "MEDIUM",
      ackDueAt: new Date("2026-10-11T10:00:00.000Z"),
      acknowledgedAt: new Date("2026-10-10T10:05:00.000Z"),
      resolutionDueAt: new Date("2026-10-25T10:00:00.000Z"),
      resolvedAt: null,
      assignedToId: "staff-1",
      awaitingUserSince: awaitingSince,
      pausedSeconds: 200,
      messageSeq: 2,
      updatedAt,
    });
    mockPrisma.supportCase.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.supportCase.findUniqueOrThrow.mockResolvedValueOnce({
      id: "case-pause-1",
      status: "RESOLVED",
      pausedSeconds: 2000,
      awaitingUserSince: null,
    });

    const res = await patchSupportCaseLifecycle(
      {
        caseId: "case-pause-1",
        actorId: "staff-1",
        status: "RESOLVED",
        expectedUpdatedAt: updatedAt.toISOString(),
      },
      now,
    );
    expect(res.ok).toBe(true);
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          awaitingUserSince: null,
          pausedSeconds: 2000,
        }),
      }),
    );
  });

  it("enforces HTTP 428 when STAFF has twoFactorEnabled: false across GET/POST cases, GET case detail, and POST messages", async () => {
    const twoFactorResponse = Response.json(
      { error: "Two-factor required", code: "TWO_FACTOR_REQUIRED" },
      { status: 428 },
    );
    mockRequireApiAuth.mockResolvedValue({ error: twoFactorResponse });

    const r1 = await getCases(
      new NextRequest("https://familiarise.com/api/support/cases"),
    );
    expect(r1.status).toBe(428);

    const r2 = await postCases(
      new NextRequest("https://familiarise.com/api/support/cases", {
        method: "POST",
        body: JSON.stringify({
          title: "Case",
          description: "Body",
          category: "GENERAL",
        }),
      }),
    );
    expect(r2.status).toBe(428);

    const r3 = await getCaseDetail(
      new NextRequest("https://familiarise.com/api/support/cases/case-1"),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(r3.status).toBe(428);

    const r4 = await postCaseMessage(
      new NextRequest(
        "https://familiarise.com/api/support/cases/case-1/messages",
        {
          method: "POST",
          body: JSON.stringify({ body: "Reply" }),
        },
      ),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(r4.status).toBe(428);
  });

  it("skips rate limiter for staff and uses ticket-response:<userId> bucket for non-staff on POST /api/support/cases/[caseId]/messages", async () => {
    const rateLimitMod = jest.requireMock<{
      applyRateLimit: jest.Mock;
      spamLimiter: unknown;
    }>("../../lib/rate-limit");

    const now = new Date("2026-10-10T12:00:00.000Z");
    mockRequireApiAuth.mockResolvedValueOnce({
      session: {
        user: {
          id: "staff-2fa",
          name: "Staff",
          role: "STAFF",
          twoFactorEnabled: true,
        },
      },
    });
    mockPrisma.supportCase.findUnique.mockResolvedValueOnce({
      id: "case-msg-1",
      referenceNumber: "FAM-2026-000777",
      status: "OPEN",
      category: "GENERAL",
      createdAt: now,
      requesterUserId: "user-1",
      submitterUserId: "user-1",
      deletedAt: null,
      messages: [],
      events: [],
      subjects: [],
    });
    mockTx.supportCase.findUnique.mockResolvedValueOnce({
      id: "case-msg-1",
      status: "OPEN",
      assignedToId: null,
      acknowledgedAt: null,
      firstAgentReplyAt: null,
      awaitingUserSince: null,
      pausedSeconds: 0,
      createdAt: now,
      lastMessageAt: now,
    });
    mockTx.supportCase.updateMany.mockResolvedValueOnce({ count: 1 });
    mockTx.supportCase.findUniqueOrThrow.mockResolvedValueOnce({
      messageSeq: 2,
    });
    mockTx.supportCaseMessage.create.mockResolvedValueOnce({
      id: "m-2",
      seq: 2,
      sender: "AGENT",
      body: "On it",
    });

    const staffRes = await postCaseMessage(
      new NextRequest(
        "https://familiarise.com/api/support/cases/case-msg-1/messages",
        {
          method: "POST",
          body: JSON.stringify({ body: "On it", isInternal: false }),
        },
      ),
      { params: Promise.resolve({ caseId: "case-msg-1" }) },
    );
    expect(staffRes.status).toBe(201);
    expect(rateLimitMod.applyRateLimit).not.toHaveBeenCalled();

    mockPrisma.supportCase.findUnique.mockResolvedValueOnce({
      id: "case-msg-1",
      referenceNumber: "FAM-2026-000777",
      status: "IN_PROGRESS",
      category: "GENERAL",
      createdAt: now,
      requesterUserId: "user-1",
      submitterUserId: "user-1",
      deletedAt: null,
      messages: [],
      events: [],
      subjects: [],
    });
    mockTx.supportCase.findUnique.mockResolvedValueOnce({
      id: "case-msg-1",
      status: "IN_PROGRESS",
      assignedToId: "staff-2fa",
      awaitingUserSince: now,
      pausedSeconds: 0,
    });
    mockTx.supportCase.updateMany.mockResolvedValueOnce({ count: 1 });
    mockTx.supportCase.findUniqueOrThrow.mockResolvedValueOnce({
      messageSeq: 3,
    });
    mockTx.supportCaseMessage.create.mockResolvedValueOnce({
      id: "m-3",
      seq: 3,
      sender: "USER",
      body: "Thanks",
    });

    const userRes = await postCaseMessage(
      new NextRequest(
        "https://familiarise.com/api/support/cases/case-msg-1/messages",
        {
          method: "POST",
          body: JSON.stringify({ body: "Thanks" }),
        },
      ),
      { params: Promise.resolve({ caseId: "case-msg-1" }) },
    );
    expect(userRes.status).toBe(201);
    expect(rateLimitMod.applyRateLimit).toHaveBeenCalledWith(
      rateLimitMod.spamLimiter,
      "ticket-response:user-1",
    );
  });

  it("validates callbackWindow enum, rejects invalid problemCaseId in tx, catches legacy P2002 CSAT duplicate with 409, stages 24h CSAT outbox prompt, and slices newest 200 messages", async () => {
    expect(CALLBACK_WINDOWS).toEqual([
      "09:00-12:00 IST",
      "12:00-15:00 IST",
      "15:00-18:00 IST",
      "18:00-21:00 IST",
    ]);
    expect(CallbackWindowSchema.safeParse("09:00-12:00 IST").success).toBe(
      true,
    );
    expect(CallbackWindowSchema.safeParse("anytime").success).toBe(false);

    mockTx.supportCase.findUnique.mockResolvedValueOnce({
      id: "not-a-problem",
      caseKind: "INCIDENT",
      deletedAt: null,
    });
    await expect(
      createOrReuseSupportCase({
        title: "Incident linking bad problem",
        description: "Body",
        category: "TECHNICAL",
        requesterUserId: "u-1",
        submitterUserId: "u-1",
        problemCaseId: "not-a-problem",
      }),
    ).rejects.toBeInstanceOf(SupportCaseValidationError);

    const now = new Date("2026-10-10T12:00:00.000Z");
    mockTx.supportCase.findUnique
      .mockResolvedValueOnce({
        id: "self-case",
        caseKind: "INCIDENT",
        status: "OPEN",
        priority: "MEDIUM",
        assignedToId: null,
        problemCaseId: null,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        id: "self-case",
        caseKind: "PROBLEM",
        deletedAt: null,
      });
    const selfProblemPatch = await patchSupportCaseLifecycle(
      {
        caseId: "self-case",
        actorId: "staff-1",
        expectedUpdatedAt: now.toISOString(),
        problemCaseId: "self-case",
      },
      now,
    );
    expect(selfProblemPatch).toMatchObject({
      ok: false,
      status: 400,
    });

    const { Prisma } = await import("@prisma/client");
    mockTx.supportCase.findUnique.mockResolvedValueOnce(null);
    mockTx.supportTicket.findUnique.mockResolvedValueOnce({
      id: "legacy-dup",
      userId: "user-1",
      status: "RESOLVED",
      resolvedAt: new Date("2026-10-08T00:00:00.000Z"),
    });
    mockTx.supportCaseEvent.findFirst.mockResolvedValueOnce(null);
    mockTx.supportCaseEvent.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    );
    const raceCsat = await submitSupportCaseCsat(
      { caseId: "legacy-dup", userId: "user-1", rating: 5 },
      now,
    );
    expect(raceCsat).toEqual({
      ok: false,
      status: 409,
      error: "This case has already been rated.",
    });

    mockTx.supportTicket.findUnique.mockResolvedValueOnce({
      id: "t-resolve-csat",
      userId: "user-1",
      referenceNumber: "FAM-2026-000888",
      title: "Billing help",
      status: "IN_PROGRESS",
      priority: "MEDIUM",
      assignedToId: "staff-1",
      organizationId: null,
      ackDueAt: now,
      acknowledgedAt: now,
      resolutionDueAt: now,
      resolvedAt: null,
      awaitingUserSince: null,
      pausedSeconds: 0,
      updatedAt: now,
    });
    mockTx.supportTicket.updateMany.mockResolvedValueOnce({ count: 1 });
    mockTx.supportTicket.findUniqueOrThrow.mockResolvedValueOnce({
      id: "t-resolve-csat",
      status: "RESOLVED",
      priority: "MEDIUM",
      referenceNumber: "FAM-2026-000888",
      title: "Billing help",
      organizationId: null,
      user: { id: "user-1", name: "User", email: "user@test.com" },
      appointmentSupportThread: null,
    });
    const resolvePatchRes = await patchStaffTicket(
      new NextRequest(
        "https://familiarise.com/api/staff/support-tickets/t-resolve-csat",
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "RESOLVED",
            expectedUpdatedAt: now.toISOString(),
          }),
        },
      ),
      { params: Promise.resolve({ ticketId: "t-resolve-csat" }) },
    );
    expect(resolvePatchRes.status).toBe(200);
    expect(mockStageBell).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        dedupeKey: expect.stringMatching(/^csat:t-resolve-csat:/),
      }),
    );

    mockPrisma.supportTicket.findFirst.mockResolvedValueOnce(null);
    mockPrisma.supportCase.findFirst.mockResolvedValueOnce({
      id: "own-case-200",
      referenceNumber: "FAM-2026-000900",
      title: "Long conversation",
      category: "GENERAL",
      status: "OPEN",
      createdAt: now,
      appointmentId: null,
      organizationId: null,
      requesterUserId: "user-1",
      submitterUserId: "user-1",
    });
    mockPrisma.supportCaseSubject.findFirst.mockResolvedValueOnce(null);
    mockPrisma.supportCaseMessage.findMany.mockResolvedValueOnce([]);
    await readOwnTicket("own-case-200", "user-1");
    expect(mockPrisma.supportCaseMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { caseId: "own-case-200", isInternal: false },
        orderBy: { seq: "asc" },
        take: -200,
      }),
    );

    mockTx.supportCase.findUnique
      .mockResolvedValueOnce({
        id: "case-stale-cas",
        status: "IN_PROGRESS",
        assignedToId: "staff-1",
        acknowledgedAt: now,
        firstAgentReplyAt: now,
        awaitingUserSince: null,
        pausedSeconds: 0,
        createdAt: now,
        lastMessageAt: new Date("2026-10-10T10:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        lastMessageAt: new Date("2026-10-10T10:05:00.000Z"),
      });
    mockTx.supportCase.updateMany.mockResolvedValueOnce({ count: 0 });
    const casConflict = await appendSupportCaseTurn(
      {
        caseId: "case-stale-cas",
        authorUserId: "staff-1",
        sender: "AGENT",
        body: "Reply racing customer turn",
        isInternal: false,
        expectedLastMessageAt: "2026-10-10T10:01:00.000Z",
      },
      now,
    );
    expect(casConflict).toMatchObject({
      ok: false,
      status: 409,
      code: "NEW_CUSTOMER_MESSAGE",
    });
    expect(mockTx.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "case-stale-cas",
          OR: [
            { lastMessageAt: null },
            {
              lastMessageAt: { lte: new Date("2026-10-10T10:01:00.000Z") },
            },
          ],
        }),
      }),
    );
  });
});
