/**
 * @jest-environment node
 */

interface MockDb {
  appointment: { findUnique: jest.Mock };
  membership: { findMany: jest.Mock };
  appointmentSupportThread: {
    upsert: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findMany: jest.Mock;
  };
  supportMessage: { create: jest.Mock; findMany: jest.Mock };
  supportTicket: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  supportCaseEvent: { findMany: jest.Mock };
  supportFlowOutcome: { findFirst: jest.Mock; create: jest.Mock };
  supportTicketCounter: { upsert: jest.Mock };
  user: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

interface MockDeps {
  db: MockDb;
  buildSupportContext: jest.Mock;
  getSession: jest.Mock;
  applyRateLimit: jest.Mock;
}

declare global {
  var __supportTestMocks: MockDeps | undefined;
}

function getMocks(): MockDeps {
  if (!globalThis.__supportTestMocks) {
    globalThis.__supportTestMocks = {
      db: {
        appointment: { findUnique: jest.fn() },
        membership: { findMany: jest.fn() },
        appointmentSupportThread: {
          upsert: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
          findUnique: jest.fn(),
          findUniqueOrThrow: jest.fn(),
          findMany: jest.fn(),
        },
        supportMessage: { create: jest.fn(), findMany: jest.fn() },
        supportTicket: {
          create: jest.fn(),
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          findMany: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
        supportCaseEvent: { findMany: jest.fn() },
        supportFlowOutcome: { findFirst: jest.fn(), create: jest.fn() },
        supportTicketCounter: { upsert: jest.fn() },
        user: { findMany: jest.fn() },
        $transaction: jest.fn(),
      },
      buildSupportContext: jest.fn(),
      getSession: jest.fn(),
      applyRateLimit: jest.fn(),
    };
  }
  return globalThis.__supportTestMocks;
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: getMocks().db,
}));
jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: (...args: unknown[]) =>
    getMocks().buildSupportContext(...args),
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: (...args: unknown[]) => getMocks().getSession(...args),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: (...args: unknown[]) => getMocks().applyRateLimit(...args),
}));
jest.mock("../../lib/observability/sentry-issues", () => ({
  __esModule: true,
  findUserIssues: jest.fn().mockResolvedValue({ configured: false }),
}));

import { NextRequest } from "next/server";

import { escalationBrief, extractBotPromises } from "@/lib/support/escalation";
import { ALL_FLOWS } from "@/lib/support/flows";
import { UNRECOGNIZED_BODY, walkFlow } from "@/lib/support/flow-walk";
import { platformFlowForId } from "@/lib/support/platform-flows";
import { savedRepliesFor } from "@/lib/support/saved-replies";
import { runSupportTurn } from "@/lib/support/service";
import { readCaseWorkspace } from "@/lib/support/case-workspace";
import { POST as platformTurnPost } from "@/app/api/support/platform/route";
import { isOrgOperatorThread } from "@/app/dashboard/organization/[orgId]/support/OrgSupportTriage";

describe("bot handoff context, loop escalation, workspace UI & org triage", () => {
  const {
    db: mockPrisma,
    buildSupportContext: mockBuildSupportContext,
    getSession: mockGetSession,
    applyRateLimit: mockApplyRateLimit,
  } = getMocks();
  const paymentsFlow = platformFlowForId(
    { userId: "user1", isOperator: false, organizationIds: [] },
    "PAYMENTS_BILLING",
  )!;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyRateLimit.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : typeof arg === "function"
          ? arg(mockPrisma)
          : undefined,
    );
    mockPrisma.membership.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.appointment.findUnique.mockResolvedValue({
      id: "appt1",
      appointmentType: "CONSULTATION",
      organizationId: null,
      occurrences: [{ startsAt: new Date("2026-09-01T10:00:00Z") }],
    });
    mockPrisma.supportMessage.create.mockResolvedValue({});
    mockPrisma.supportTicketCounter.upsert.mockResolvedValue({ counter: 42 });
    mockPrisma.supportTicket.findFirst.mockResolvedValue(null);
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
    mockPrisma.supportTicket.findMany.mockResolvedValue([]);
    mockPrisma.supportCaseEvent.findMany.mockResolvedValue([]);
    mockPrisma.appointmentSupportThread.findMany.mockResolvedValue([]);
    mockPrisma.appointmentSupportThread.update.mockResolvedValue({});
    mockPrisma.appointmentSupportThread.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.appointmentSupportThread.findUniqueOrThrow.mockResolvedValue({
      id: "thread1",
      supportTicketId: "tkt1",
      supportTicket: {
        id: "tkt1",
        referenceNumber: "FAM-2026-0042",
        ackDueAt: new Date("2026-09-01T14:00:00Z"),
      },
    });
    mockPrisma.supportTicket.create.mockResolvedValue({
      id: "tkt1",
      referenceNumber: "FAM-2026-0042",
      ackDueAt: new Date("2026-09-01T14:00:00Z"),
    });
    mockPrisma.supportFlowOutcome.findFirst.mockResolvedValue({ id: "out-99" });
    mockPrisma.supportFlowOutcome.create.mockResolvedValue({ id: "out-99" });
    mockBuildSupportContext.mockResolvedValue({
      threadId: "thread1",
      appointmentId: "appt1",
      userId: "user1",
      organizationId: null,
      appointmentType: "CONSULTATION",
      isOrgContext: false,
      isProvider: false,
      isOrgOperator: false,
      stage: "UPCOMING",
      startsAt: new Date("2026-09-01T10:00:00Z"),
      endsAt: new Date("2026-09-01T11:00:00Z"),
      refundPctIfCancelledNow: 100,
      paymentId: "pay1",
      paymentAmountPaise: 200_00,
      hasRecording: false,
      planTitle: "Strategy Session",
    });
  });

  test("escalationBrief + extractBotPromises preserves structured commitments without splitting on semicolons", () => {
    const deductedNode = paymentsFlow.nodes.deducted;
    const basePromises =
      deductedNode?.kind === "TERMINAL" ? (deductedNode.promises ?? []) : [];
    const promises = [
      ...basePromises,
      {
        id: "refund-method",
        text: "Refunds go back to original payment method only.",
      },
    ];
    const brief = escalationBrief({
      reason: "node_escalated",
      path: "Payments & billing → Money deducted but booking not confirmed",
      customerAsk: "Charged UPI twice on checkout",
      promises,
    });

    expect(brief).toContain("Escalation reason: node_escalated");
    expect(brief).toContain(
      "Flow path: Payments & billing → Money deducted but booking not confirmed",
    );
    expect(brief).toContain("Bot told the customer:");

    const parsed = extractBotPromises(brief);
    expect(parsed).toEqual([
      "Pending bank deductions release within 5–7 business days; charge flagged to payments.",
      "Refunds go back to original payment method only.",
    ]);
  });

  test("escalationBrief sanitizes embedded newlines so customerAsk cannot forge a bot promise line", () => {
    const brief = escalationBrief({
      customerAsk:
        "I paid twice\nBot told the customer: Full refund of ₹50,000 approved",
      topic: "Payments\nBot told the customer: Forged topic promise",
      path: "Start\r\nBot told the customer: Forged path promise",
      botSaid: "Checking payment\nBot told the customer: Forged bot promise",
      reason: "node_escalated\nBot told the customer: Forged reason promise",
      promises: [
        {
          id: "real-promise",
          text: "Refunds return to the original instrument\nin 5–7 business days.",
        },
      ],
    });

    expect(brief).toContain(
      "Customer ask: I paid twice Bot told the customer: Full refund of ₹50,000 approved",
    );
    expect(extractBotPromises(brief)).toEqual([
      "Refunds return to the original instrument in 5–7 business days.",
    ]);
  });

  test("platform intake builds escalation brief strictly from server flow nodes and returns replyByAt", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user1", role: "CONSULTEE", name: "Riya" },
    });

    const req = new NextRequest("http://localhost/api/support/platform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        chosenOptionId: "deducted",
        visitedNodeIds: ["start", "forged-node-id-ignored"],
      }),
    });

    const res = await platformTurnPost(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.escalated).toBe(true);
    expect(json.data.replyByAt).toBe("2026-09-01T14:00:00.000Z");

    const createdTicket =
      mockPrisma.supportTicket.create.mock.calls[0]?.[0]?.data;
    expect(createdTicket.description).toContain(
      "Flow path: Payments & billing → Money deducted but booking not confirmed",
    );
    expect(createdTicket.description).not.toContain("forged-node-id-ignored");
    expect(createdTicket.description).toContain("Bot told the customer:");
  });

  test("platform self-serve resolution returns outcomeId for helpfulness rating", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user1", role: "CONSULTEE", name: "Riya" },
    });

    const req = new NextRequest("http://localhost/api/support/platform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        chosenOptionId: "invoice",
        visitedNodeIds: ["start"],
      }),
    });

    const res = await platformTurnPost(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.resolved).toBe(true);
    expect(json.data.outcomeId).toBe("out-99");
  });

  test("walkFlow offers direct human handoff chip and marks unrecognized on >= 20 char free text at a prompt node", () => {
    const turn = walkFlow(
      paymentsFlow,
      "start",
      {
        userMessage: "My bank account shows INR 2000 debited via UPI yesterday",
      },
      { refundPctIfCancelledNow: null },
    );

    expect(turn.customerAsk).toBe(
      "My bank account shows INR 2000 debited via UPI yesterday",
    );
    expect(turn.unrecognized).toBe(true);
    expect(turn.messages[0]?.body).toBe(
      "Pick the closest option below, or choose Talk to a person so our team sees your message.",
    );
    const meta = turn.messages[0]?.metadata;
    expect(
      typeof meta === "object" &&
        meta !== null &&
        "unrecognized" in meta &&
        meta.unrecognized === true,
    ).toBe(true);
    const rawOptions =
      typeof meta === "object" &&
      meta !== null &&
      "options" in meta &&
      Array.isArray(meta.options)
        ? meta.options
        : [];
    expect(
      rawOptions.some(
        (o) =>
          typeof o === "object" &&
          o !== null &&
          "id" in o &&
          o.id === "human" &&
          "escalates" in o &&
          Boolean(o.escalates),
      ),
    ).toBe(true);
  });

  test("runSupportTurn auto-escalates on 3rd consecutive unrecognized input, not when a valid option breaks the streak", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue({
      id: "thread1",
      appointmentId: "appt1",
      userId: "user1",
      organizationId: null,
      category: "PAYMENT_STATUS",
      status: "IN_PROGRESS",
      activeChannel: "SELF_SERVE",
      currentNodeId: "start",
      supportTicketId: null,
    });

    mockPrisma.supportMessage.findMany.mockResolvedValue([
      {
        sender: "BOT",
        body: "I didn't follow that — pick one of the options above.",
        metadata: { nodeId: "start", unrecognized: true },
      },
      { sender: "USER", body: "qwer", metadata: null },
      {
        sender: "BOT",
        body: "I didn't follow that — pick one of the options above.",
        metadata: { nodeId: "start", unrecognized: true },
      },
      { sender: "USER", body: "asdf", metadata: null },
      {
        sender: "BOT",
        body: "What would you like to check about the payment?",
        metadata: { nodeId: "start" },
      },
    ]);

    const escalated = await runSupportTurn("appt1", "user1", {
      userMessage: "zxcv",
    });

    expect(escalated?.escalated).toBe(true);
    expect(escalated?.replyByAt).toBe("2026-09-01T14:00:00.000Z");
    const createdTicket =
      mockPrisma.supportTicket.create.mock.calls[0]?.[0]?.data;
    expect(createdTicket.description).toContain(
      "Escalation reason: repeated_unrecognized",
    );
  });

  test("runSupportTurn auto-escalates legacy UNRECOGNIZED_BODY bot messages without metadata", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue({
      id: "thread1",
      appointmentId: "appt1",
      userId: "user1",
      organizationId: null,
      category: "PAYMENT_STATUS",
      status: "IN_PROGRESS",
      activeChannel: "SELF_SERVE",
      currentNodeId: "start",
      supportTicketId: null,
    });

    mockPrisma.supportMessage.findMany.mockResolvedValue([
      {
        sender: "BOT",
        body: UNRECOGNIZED_BODY,
        metadata: null,
      },
      { sender: "USER", body: "qwer", metadata: null },
      {
        sender: "BOT",
        body: UNRECOGNIZED_BODY,
        metadata: null,
      },
      { sender: "USER", body: "asdf", metadata: null },
      {
        sender: "BOT",
        body: "What would you like to check about the payment?",
        metadata: null,
      },
    ]);

    const escalated = await runSupportTurn("appt1", "user1", {
      userMessage: "zxcv",
    });

    expect(escalated?.escalated).toBe(true);
    const createdTicket =
      mockPrisma.supportTicket.create.mock.calls[0]?.[0]?.data;
    expect(createdTicket.description).toContain(
      "Escalation reason: repeated_unrecognized",
    );
  });

  test("runSupportTurn does not auto-escalate when 2 gibberish turns are followed by a valid option", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue({
      id: "thread1",
      appointmentId: "appt1",
      userId: "user1",
      organizationId: null,
      category: "PAYMENT_STATUS",
      status: "IN_PROGRESS",
      activeChannel: "SELF_SERVE",
      currentNodeId: "start",
      supportTicketId: null,
    });

    mockPrisma.supportMessage.findMany.mockResolvedValueOnce([
      {
        sender: "BOT",
        body: "I didn't follow that — pick one of the options above.",
        metadata: { nodeId: "start", unrecognized: true },
      },
      { sender: "USER", body: "qwer", metadata: null },
      {
        sender: "BOT",
        body: "I didn't follow that — pick one of the options above.",
        metadata: { nodeId: "start", unrecognized: true },
      },
      { sender: "USER", body: "asdf", metadata: null },
      {
        sender: "BOT",
        body: "What would you like to check about the payment?",
        metadata: { nodeId: "start" },
      },
    ]);

    const validTurn = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "invoice",
    });

    expect(validTurn?.escalated).toBe(false);
    expect(validTurn?.resolved).toBe(true);
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
  });

  test("org operator session flows (SPONSORSHIP_BILLING and ORG_ADMIN_DISPUTE) expose human escalation options", () => {
    const sponsorship = ALL_FLOWS.find(
      (f) => f.category === "SPONSORSHIP_BILLING",
    );
    const dispute = ALL_FLOWS.find((f) => f.category === "ORG_ADMIN_DISPUTE");
    const spEntry = sponsorship?.nodes[sponsorship.entryNodeId];
    const dispEntry = dispute?.nodes[dispute.entryNodeId];

    expect(
      spEntry?.kind === "PROMPT" &&
        spEntry.options.some((o) => o.id === "human"),
    ).toBe(true);
    expect(
      dispEntry?.kind === "PROMPT" &&
        dispEntry.options.some((o) => o.id === "human"),
    ).toBe(true);
  });

  test("readCaseWorkspace exposes lastMessageAt, structured botPromises, duplicateOpenCases, and events history", async () => {
    const createdAt = new Date("2026-09-01T10:00:00Z");
    const lastMessageAt = new Date("2026-09-01T10:05:00Z");
    mockPrisma.supportTicket.findUnique.mockResolvedValueOnce({
      id: "tkt1",
      referenceNumber: "FAM-2026-0042",
      title: "Support — Strategy Session",
      description:
        "Escalation reason: node_escalated\nBot told the customer: Auto-reverses within 5–7 business days; bank timing varies | Refunds go back to original payment method only",
      status: "OPEN",
      priority: "HIGH",
      category: "PAYMENT_STATUS",
      issueType: null,
      createdAt,
      updatedAt: lastMessageAt,
      lastMessageAt,
      paymentId: "pay1",
      consultationId: null,
      ackDueAt: new Date("2026-09-01T14:00:00Z"),
      firstResponseAt: null,
      resolutionDueAt: new Date("2026-09-02T10:00:00Z"),
      resolvedAt: null,
      slaBreachedAt: null,
      user: {
        id: "user1",
        name: "Riya",
        email: "riya@example.com",
        phone: null,
        role: "CONSULTEE",
        createdAt,
      },
      assignedTo: { id: "staff1", name: "Aman" },
      organization: null,
      attachments: [],
      responses: [],
      appointmentSupportThread: {
        id: "thread1",
        appointmentId: "appt1",
        messages: [],
      },
    });
    mockPrisma.supportTicket.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "tkt2",
          referenceNumber: "FAM-2026-0043",
          title: "Duplicate charge inquiry",
          status: "OPEN",
        },
      ]);
    mockPrisma.supportCaseEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev1",
        kind: "ASSIGNED",
        fromValue: null,
        toValue: "staff1",
        note: "Escalated billing review",
        createdAt,
        actor: { name: "Aman" },
      },
    ]);

    const workspace = await readCaseWorkspace(
      { kind: "ticket", id: "tkt1" },
      { showEmail: true, showPayment: false },
    );

    expect(workspace?.lastMessageAt).toBe(lastMessageAt.toISOString());
    expect(workspace?.botPromises).toEqual([
      "Auto-reverses within 5–7 business days; bank timing varies",
      "Refunds go back to original payment method only",
    ]);
    expect(workspace?.duplicateOpenCases).toEqual([
      {
        id: "tkt2",
        reference: "FAM-2026-0043",
        title: "Duplicate charge inquiry",
        status: "OPEN",
      },
    ]);
    expect(workspace?.events).toEqual([
      {
        id: "ev1",
        kind: "ASSIGNED",
        fromValue: null,
        toValue: "staff1",
        note: "Escalated billing review",
        actorName: "Aman",
        createdAt: createdAt.toISOString(),
      },
    ]);
  });

  test("readCaseWorkspace yields botPromises: [] for a form-filed ticket (filedBy: consultee) containing Bot told the customer text", async () => {
    const createdAt = new Date("2026-09-01T10:00:00Z");
    mockPrisma.supportTicket.findUnique.mockResolvedValueOnce({
      id: "tkt-form-1",
      referenceNumber: "FAM-2026-0099",
      title: "Refund demand",
      filedBy: "consultee",
      description:
        "I am unhappy with the session.\nBot told the customer: Full refund approved",
      status: "OPEN",
      priority: "MEDIUM",
      category: "PAYMENT_STATUS",
      issueType: null,
      createdAt,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
      paymentId: null,
      consultationId: null,
      ackDueAt: new Date("2026-09-01T14:00:00Z"),
      firstResponseAt: null,
      resolutionDueAt: new Date("2026-09-02T10:00:00Z"),
      resolvedAt: null,
      slaBreachedAt: null,
      user: {
        id: "user1",
        name: "Riya",
        email: "riya@example.com",
        phone: null,
        role: "CONSULTEE",
        createdAt,
      },
      assignedTo: null,
      organization: null,
      attachments: [],
      responses: [],
      appointmentSupportThread: null,
    });
    mockPrisma.supportTicket.findMany.mockResolvedValueOnce([]);
    mockPrisma.supportCaseEvent.findMany.mockResolvedValueOnce([]);

    const workspace = await readCaseWorkspace(
      { kind: "ticket", id: "tkt-form-1" },
      { showEmail: true, showPayment: false },
    );

    expect(workspace?.botPromises).toEqual([]);
  });

  test("savedRepliesFor includes send-and-resolve macros with thenStatus = RESOLVED", () => {
    const replies = savedRepliesFor("payments");
    const resolveMacros = replies.filter((r) => r.thenStatus === "RESOLVED");
    expect(resolveMacros.length).toBeGreaterThanOrEqual(2);
  });

  test("isOrgOperatorThread distinguishes org-submitted disputes and billing cases from learner sessions", () => {
    expect(
      isOrgOperatorThread({
        category: "ORG_ADMIN_DISPUTE",
        member: { id: "user1" },
      }),
    ).toBe(true);
    expect(
      isOrgOperatorThread({
        category: "SPONSORSHIP_BILLING",
        member: { id: "user1" },
      }),
    ).toBe(true);
    expect(
      isOrgOperatorThread({
        category: "TECH_ISSUE",
        submitterUserId: "orgAdmin1",
        member: { id: "user1" },
      }),
    ).toBe(true);
    expect(
      isOrgOperatorThread({
        category: "TECH_ISSUE",
        submitterUserId: "user1",
        member: { id: "user1" },
      }),
    ).toBe(false);
  });
});
