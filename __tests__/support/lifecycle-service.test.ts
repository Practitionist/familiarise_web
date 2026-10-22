/** @jest-environment node */

const mockContext = jest.fn();
const mockCreateCase = jest.fn();
const mockAppend = jest.fn();
const mockLatestDecision = jest.fn();
const mockOpenCaseConflict = jest.fn();
const mockResolve = jest.fn();
const mockDecision = jest.fn();
const now = new Date("2026-10-19T12:00:00Z");
const baseCase = {
  id: "case-1",
  referenceNumber: "FAM-2026-000001",
  requesterUserId: "requester",
  submitterUserId: "requester",
  category: "OTHER",
  status: "OPEN",
  activeChannel: "SELF_SERVE",
  currentNodeId: null,
  organizationId: null,
  ownershipScope: "PERSONAL",
  scopeKey: "APPOINTMENT:appointment",
  assignedToId: null,
  closedAt: null,
  deletedAt: null,
  priority: "MEDIUM",
  ackDueAt: now,
  updatedAt: now,
  messageSeq: 1,
  awaitingUserSince: null,
  pausedSeconds: 0,
};
const mockDb = {
  appointment: { findUnique: jest.fn() },
  supportCase: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  supportCaseMessage: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  supportCaseEvent: { create: jest.fn() },
  membership: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
  ALLOCATION_TX_MAX_WAIT_MS: 10000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));
jest.mock("../../lib/booking/participants", () => ({
  seatOrganizationId: jest.fn(async () => null),
}));
jest.mock("../../lib/support/context", () => ({
  buildSupportContext: (...args: unknown[]) => mockContext(...args),
}));
jest.mock("../../lib/support/case-service", () => ({
  createOrReuseSupportCase: (...args: unknown[]) => mockCreateCase(...args),
  appendSupportCaseTurn: (...args: unknown[]) => mockAppend(...args),
  latestCaseDecisionTx: (...args: unknown[]) => mockLatestDecision(...args),
  openCaseConflict: (...args: unknown[]) => mockOpenCaseConflict(...args),
  stageSupportCaseIntakeTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/support/flows", () => ({
  flowForCategory: () => ({ title: "Help", nodes: {} }),
}));
jest.mock("../../lib/support/resolvers/flowchart-resolver", () => ({
  FlowchartResolver: class {
    resolveTurn(...args: unknown[]) {
      return mockResolve(...args);
    }
  },
}));
jest.mock("../../lib/support/escalation", () => ({
  decideEscalation: (...args: unknown[]) => mockDecision(...args),
  isBareHumanRequest: () => false,
  escalationBrief: () => "Handoff summary",
}));
jest.mock("../../lib/support/deflection", () => ({
  recordFlowOutcome: jest.fn(async () => "outcome"),
}));

import { runSupportTurn } from "../../lib/support/service";
import { CaseConflictError } from "../../lib/support/case-transitions";

const uniqueViolation = () =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
const eventKinds = () =>
  mockDb.supportCaseEvent.create.mock.calls.map(([args]) => args.data.kind);

function threadIs(overrides: Record<string, unknown>) {
  const row = { ...baseCase, ...overrides };
  mockDb.supportCase.findFirst.mockResolvedValue(row);
  mockDb.supportCase.findUniqueOrThrow.mockResolvedValue(row);
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (fn) => fn(mockDb));
  mockDb.appointment.findUnique.mockResolvedValue({
    id: "appointment",
    appointmentType: "CONSULTATION",
    organizationId: "org-1",
  });
  threadIs({});
  mockDb.supportCase.updateMany.mockResolvedValue({ count: 1 });
  mockDb.supportCase.update.mockResolvedValue({ messageSeq: 3 });
  mockDb.supportCaseMessage.findUnique.mockResolvedValue(null);
  mockDb.supportCaseMessage.findMany.mockResolvedValue([]);
  mockDb.membership.findFirst.mockResolvedValue(null);
  mockCreateCase.mockResolvedValue({
    supportCase: { ...baseCase, id: "new-case" },
    reused: false,
  });
  mockAppend.mockResolvedValue({ ok: true, replayed: false, messages: [] });
  mockLatestDecision.mockResolvedValue(null);
  mockOpenCaseConflict.mockResolvedValue(null);
  mockContext.mockResolvedValue({
    userId: "requester",
    appointmentId: "appointment",
    appointmentType: "CONSULTATION",
    organizationId: "org-1",
    planTitle: "Consultation",
  });
  mockResolve.mockResolvedValue({
    messages: [{ sender: "BOT", body: "Choose a next step" }],
    nextNodeId: "next",
    actions: [],
    resolved: false,
    escalate: false,
  });
  mockDecision.mockReturnValue({ escalate: false });
});

describe("a resolved human conversation", () => {
  it("starts a new request when the customer picks a new intent", async () => {
    threadIs({ status: "RESOLVED", activeChannel: "HUMAN" });
    const result = await runSupportTurn("appointment", "requester", {
      category: "PAYMENT_STATUS",
    });
    expect(mockDb.supportCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
    expect(mockCreateCase).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT_STATUS" }),
    );
    expect(result?.threadId).toBe("new-case");
    expect(
      mockDb.supportCase.updateMany.mock.calls.every(
        ([args]) => args.where.id === "new-case",
      ),
    ).toBe(true);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("takes a plain message as a follow-up on the same case", async () => {
    threadIs({ status: "RESOLVED", activeChannel: "HUMAN" });
    const result = await runSupportTurn("appointment", "requester", {
      userMessage: "One more thing",
    });
    expect(mockCreateCase).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-1", body: "One more thing" }),
    );
    expect(result).toMatchObject({ status: "RESOLVED" });
  });

  it('reopens on "This didn\'t fix it"', async () => {
    threadIs({ status: "RESOLVED", activeChannel: "HUMAN" });
    const result = await runSupportTurn("appointment", "requester", {
      userMessage: "Still broken",
      reopen: true,
    });
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ reopen: true }),
    );
    expect(result).toMatchObject({ status: "OPEN", accepted: true });
  });

  it("surfaces a refused reopen as a conflict with the appeal deadline", async () => {
    threadIs({ status: "RESOLVED", activeChannel: "HUMAN" });
    mockAppend.mockResolvedValue({
      ok: false,
      status: 409,
      code: "CASE_DECIDED",
      error: "This request has a decision.",
      appealUntil: "2026-10-22T00:00:00.000Z",
      decisionId: "decision-1",
    });
    const attempt = runSupportTurn("appointment", "requester", {
      userMessage: "Still broken",
      reopen: true,
    });
    await expect(attempt).rejects.toBeInstanceOf(CaseConflictError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      body: {
        code: "CASE_DECIDED",
        appealUntil: "2026-10-22T00:00:00.000Z",
        decisionId: "decision-1",
      },
    });
  });
});

describe("guided turns", () => {
  it("never write the channel, so a human case cannot drop back to self-serve", async () => {
    const result = await runSupportTurn("appointment", "requester", {
      userMessage: "Question",
    });
    const [args] = mockDb.supportCase.updateMany.mock.calls[0];
    expect(args.data).not.toHaveProperty("activeChannel");
    expect(result?.activeChannel).toBe("SELF_SERVE");
  });

  it("answer a category switch that collides with another open case with that case", async () => {
    mockDb.$transaction.mockRejectedValueOnce(uniqueViolation());
    mockOpenCaseConflict.mockResolvedValue({
      status: 409,
      code: "OPEN_CASE_EXISTS",
      error: "There's already an open request about this.",
      existingCase: {
        id: "other",
        referenceNumber: "FAM-2",
        caseKey: "c_other",
      },
    });
    const attempt = runSupportTurn("appointment", "requester", {
      category: "PAYMENT_STATUS",
    });
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      body: {
        code: "OPEN_CASE_EXISTS",
        existingCase: { caseKey: "c_other" },
      },
    });
    expect(mockOpenCaseConflict).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT_STATUS" }),
      "case-1",
    );
  });

  it("rethrow a unique violation no open case explains", async () => {
    const failure = uniqueViolation();
    mockDb.$transaction.mockRejectedValueOnce(failure);
    await expect(
      runSupportTurn("appointment", "requester", { userMessage: "Question" }),
    ).rejects.toBe(failure);
  });
});

describe("escalation", () => {
  beforeEach(() => {
    mockDecision.mockReturnValue({ escalate: true, reason: "needs_human" });
  });

  it("records the channel change alongside the status change", async () => {
    await runSupportTurn("appointment", "requester", {
      userMessage: "Please investigate",
    });
    expect(eventKinds()).toEqual(["STATUS_CHANGED", "CHANNEL_CHANGED"]);
    expect(mockDb.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "CHANNEL_CHANGED",
        fromValue: "SELF_SERVE",
        toValue: "HUMAN",
      }),
    });
  });

  it("refuses to escalate a decided case", async () => {
    threadIs({ status: "RESOLVED" });
    mockLatestDecision.mockResolvedValue({
      id: "decision-1",
      appealUntil: now,
    });
    await expect(
      runSupportTurn("appointment", "requester", {
        userMessage: "Please investigate",
      }),
    ).rejects.toMatchObject({ status: 409, body: { code: "CASE_DECIDED" } });
    expect(mockDb.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("hands an undecided guided answer to a person", async () => {
    threadIs({ status: "RESOLVED" });
    await expect(
      runSupportTurn("appointment", "requester", {
        userMessage: "Please investigate",
      }),
    ).resolves.toMatchObject({ escalated: true, status: "ESCALATED" });
  });
});

describe("org billing disputes", () => {
  beforeEach(() => {
    threadIs({ ownershipScope: "ORG_OPERATIONS", organizationId: "org-1" });
    mockDecision.mockReturnValue({
      escalate: true,
      reason: "org_billing_dispute",
    });
  });
  const dispute = () =>
    runSupportTurn("appointment", "requester", {
      category: "ORG_ADMIN_DISPUTE",
      userMessage: "We were charged twice",
      isOrgParty: true,
    });

  it("move to the billing queue when the filer manages billing", async () => {
    mockDb.membership.findFirst.mockResolvedValue({ role: "BILLING_ADMIN" });
    await dispute();
    expect(mockDb.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "requester",
          organizationId: "org-1",
          status: "ACTIVE",
        },
      }),
    );
    expect(mockDb.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownershipScope: "ORG_BILLING",
          issueType: "BILLING_QUESTION",
          status: "ESCALATED",
        }),
      }),
    );
  });

  it("stay with operations as a billing question otherwise", async () => {
    mockDb.membership.findFirst.mockResolvedValue({ role: "MANAGER" });
    await dispute();
    expect(mockDb.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownershipScope: "ORG_OPERATIONS",
          issueType: "BILLING_QUESTION",
        }),
      }),
    );
  });

  it("never re-scope a personal conversation", async () => {
    threadIs({ ownershipScope: "PERSONAL", organizationId: "org-1" });
    mockDb.membership.findFirst.mockResolvedValue({ role: "OWNER" });
    await dispute();
    expect(mockDb.membership.findFirst).not.toHaveBeenCalled();
    expect(mockDb.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownershipScope: "PERSONAL" }),
      }),
    );
  });

  it("answer a re-scope collision with the open billing case", async () => {
    mockDb.membership.findFirst.mockResolvedValue({ role: "OWNER" });
    mockDb.$transaction.mockImplementationOnce(async (fn) => {
      await fn(mockDb);
      throw uniqueViolation();
    });
    mockOpenCaseConflict.mockResolvedValue({
      status: 409,
      code: "OPEN_CASE_EXISTS",
      error: "There's already an open request about this.",
      existingCase: {
        id: "billing",
        referenceNumber: "FAM-3",
        caseKey: "c_billing",
      },
    });
    await expect(dispute()).rejects.toMatchObject({
      status: 409,
      body: { code: "OPEN_CASE_EXISTS" },
    });
    expect(mockOpenCaseConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        ownershipScope: "ORG_BILLING",
        category: "ORG_ADMIN_DISPUTE",
      }),
      "case-1",
    );
  });
});
