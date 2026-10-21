/** @jest-environment node */

const mockContext = jest.fn();
const mockCreateCase = jest.fn();
const mockResolve = jest.fn();
const mockDecision = jest.fn();
const mockSeat = jest.fn();
const mockNotify = jest.fn(async (..._args: unknown[]) => undefined);
const mockCase = {
  id: "canonical-case",
  requesterUserId: "requester",
  submitterUserId: "requester",
  category: "OTHER",
  status: "OPEN",
  activeChannel: "SELF_SERVE",
  currentNodeId: null,
  organizationId: null,
  closedAt: null,
  deletedAt: null,
  priority: "MEDIUM",
  ackDueAt: new Date("2026-10-20T12:00:00Z"),
  updatedAt: new Date("2026-10-19T12:00:00Z"),
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
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    get appointment() {
      return mockDb.appointment;
    },
    get supportCase() {
      return mockDb.supportCase;
    },
    get supportCaseMessage() {
      return mockDb.supportCaseMessage;
    },
    get supportCaseEvent() {
      return mockDb.supportCaseEvent;
    },
    $transaction: jest.fn(async (fn) => fn(mockDb)),
  },
  ALLOCATION_TX_MAX_WAIT_MS: 10000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));
jest.mock("../../lib/booking/participants", () => ({
  seatOrganizationId: (...args: unknown[]) => mockSeat(...args),
}));
jest.mock("../../lib/support/context", () => ({
  buildSupportContext: (...args: unknown[]) => mockContext(...args),
}));
jest.mock("../../lib/support/case-service", () => ({
  createOrReuseSupportCase: (...args: unknown[]) => mockCreateCase(...args),
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
  escalationBrief: () => "Canonical handoff summary",
}));
jest.mock("../../lib/support/create-ticket", () => ({
  notifyRequesterOfTicket: (...args: unknown[]) => mockNotify(...args),
  notifySupportStaff: (...args: unknown[]) => mockNotify(...args),
  notifyStaffOfTicketActivity: (...args: unknown[]) => mockNotify(...args),
}));
jest.mock("../../lib/support/deflection", () => ({
  recordFlowOutcome: jest.fn(async () => "outcome"),
}));

import { runSupportTurn } from "../../lib/support/service";

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.appointment.findUnique.mockResolvedValue({
    id: "appointment",
    appointmentType: "CONSULTATION",
    organizationId: null,
  });
  mockDb.supportCase.findFirst.mockResolvedValue(mockCase);
  mockDb.supportCase.findUniqueOrThrow.mockResolvedValue(mockCase);
  mockDb.supportCase.updateMany.mockResolvedValue({ count: 1 });
  mockDb.supportCase.update.mockResolvedValue({ messageSeq: 3 });
  mockDb.supportCaseMessage.create.mockResolvedValue({ id: "message" });
  mockDb.supportCaseMessage.findMany.mockResolvedValue([]);
  mockCreateCase.mockResolvedValue({ supportCase: mockCase, reused: false });
  mockContext.mockResolvedValue({
    userId: "requester",
    appointmentId: "appointment",
    appointmentType: "CONSULTATION",
    organizationId: null,
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
  mockSeat.mockResolvedValue(null);
});

it("creates one canonical intake with derived requester/organization and reuses that row for later turns", async () => {
  mockDb.supportCase.findFirst.mockResolvedValueOnce(null);
  await runSupportTurn("appointment", "requester", { category: "OTHER" });
  await runSupportTurn("appointment", "requester", { userMessage: "Question" });
  expect(mockCreateCase).toHaveBeenCalledTimes(1);
  expect(mockCreateCase).toHaveBeenCalledWith(
    expect.objectContaining({
      requesterUserId: "requester",
      submitterUserId: "requester",
      appointmentId: "appointment",
      organizationId: null,
      clientIntakeId: expect.stringMatching(/^appointment-/),
      initialSender: "SYSTEM",
    }),
  );
  expect(
    mockDb.supportCaseMessage.create.mock.calls.every(
      ([args]) => args.data.caseId === "canonical-case",
    ),
  ).toBe(true);
});

it("stores the user and bot exchange in sequence on the case", async () => {
  const result = await runSupportTurn("appointment", "requester", {
    userMessage: "Question",
  });
  expect(result).toMatchObject({ threadId: "canonical-case", accepted: true });
  expect(
    mockDb.supportCaseMessage.create.mock.calls.map(([args]) => [
      args.data.seq,
      args.data.sender,
    ]),
  ).toEqual([
    [2, "USER"],
    [3, "BOT"],
  ]);
});

it("hands off the same case to an operator without creating or linking a second ticket", async () => {
  mockDecision.mockReturnValue({ escalate: true, reason: "needs_human" });
  const result = await runSupportTurn("appointment", "requester", {
    userMessage: "Please investigate",
  });
  expect(result).toMatchObject({
    threadId: "canonical-case",
    supportTicketId: "canonical-case",
    escalated: true,
    accepted: true,
  });
  expect(mockCreateCase).not.toHaveBeenCalled();
  expect(mockDb.supportCase.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        activeChannel: "HUMAN",
        status: "ESCALATED",
      }),
    }),
  );
  expect(mockDb.supportCaseEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        caseId: "canonical-case",
        kind: "STATUS_CHANGED",
      }),
    }),
  );
});

it("does not append an exchange when another actor closes or changes the case", async () => {
  mockDb.supportCase.updateMany.mockResolvedValueOnce({ count: 0 });
  mockDb.supportCase.findUniqueOrThrow.mockResolvedValueOnce({
    status: "CLOSED",
  });
  const result = await runSupportTurn("appointment", "requester", {
    userMessage: "Question",
  });
  expect(result).toMatchObject({
    accepted: false,
    status: "CLOSED",
    messages: [],
  });
  expect(mockDb.supportCaseMessage.create).not.toHaveBeenCalled();
});
