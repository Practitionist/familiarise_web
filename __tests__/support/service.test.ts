/** @jest-environment node */
jest.mock("../../lib/prisma", () => {
  const db = {
    appointment: { findUnique: jest.fn() },
    supportCase: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseMessage: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    supportCaseEvent: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
    fn(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});
jest.mock("../../lib/booking/participants", () => ({
  seatOrganizationId: jest.fn(async () => null),
}));
jest.mock("../../lib/support/context", () => ({
  buildSupportContext: jest.fn(),
}));
jest.mock("../../lib/support/case-service", () => ({
  createOrReuseSupportCase: jest.fn(),
  stageSupportCaseIntakeTx: jest.fn(async () => undefined),
  appendSupportCaseTurn: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../lib/support/create-ticket", () => ({
  notifyRequesterOfTicket: jest.fn(async () => undefined),
  notifySupportStaff: jest.fn(async () => undefined),
  notifyStaffOfTicketActivity: jest.fn(async () => undefined),
}));
jest.mock("../../lib/support/deflection", () => ({
  recordFlowOutcome: jest.fn(async () => "outcome"),
}));
import prisma from "../../lib/prisma";
import { buildSupportContext } from "../../lib/support/context";
import { appendSupportCaseTurn } from "../../lib/support/case-service";
import { runSupportTurn } from "../../lib/support/service";
const db = jest.requireMock<{
  default: {
    appointment: { findUnique: jest.Mock };
    supportCase: {
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    supportCaseMessage: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
    supportCaseEvent: { create: jest.Mock };
  };
}>("../../lib/prisma").default;
const now = new Date("2026-10-19T10:00:00Z");
const fixture = (overrides: Record<string, unknown> = {}) => ({
  id: "case",
  requesterUserId: "customer",
  submitterUserId: "customer",
  organizationId: null,
  appointmentId: "appointment",
  category: "CANCEL_REFUND",
  status: "OPEN",
  activeChannel: "SELF_SERVE",
  currentNodeId: null,
  closedAt: null,
  deletedAt: null,
  updatedAt: now,
  priority: "MEDIUM",
  awaitingUserSince: null,
  pausedSeconds: 0,
  messageSeq: 1,
  ackDueAt: now,
  ...overrides,
});
beforeEach(() => {
  jest.clearAllMocks();
  db.appointment.findUnique.mockResolvedValue({
    id: "appointment",
    appointmentType: "CONSULTATION",
    organizationId: null,
  });
  db.supportCase.findFirst.mockResolvedValue(fixture());
  db.supportCase.findUniqueOrThrow.mockResolvedValue(fixture());
  db.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.supportCase.update.mockResolvedValue({ messageSeq: 3 });
  db.supportCaseMessage.findUnique.mockResolvedValue(null);
  db.supportCaseMessage.findMany.mockResolvedValue([]);
  jest.mocked(buildSupportContext).mockResolvedValue({
    threadId: "case",
    appointmentId: "appointment",
    userId: "customer",
    organizationId: null,
    appointmentType: "CONSULTATION",
    isOrgContext: false,
    isProvider: false,
    isOrgOperator: false,
    stage: "UPCOMING",
    startsAt: now,
    endsAt: new Date(now.getTime() + 3_600_000),
    lastEndedOccurrenceId: null,
    refundPctIfCancelledNow: 100,
    paymentId: "payment",
    paymentAmountPaise: 20000,
    hasRecording: false,
    planTitle: "Strategy session",
  });
});
it("returns null for a missing appointment", async () => {
  db.appointment.findUnique.mockResolvedValueOnce(null);
  expect(
    await runSupportTurn("missing", "customer", { category: "CANCEL_REFUND" }),
  ).toBeNull();
});
it("presents the real flow's entry prompt on the canonical conversation", async () => {
  expect(
    await runSupportTurn("appointment", "customer", {
      category: "CANCEL_REFUND",
    }),
  ).toMatchObject({
    threadId: "case",
    status: "IN_PROGRESS",
    currentNodeId: "start",
    escalated: false,
  });
});
it("preserves the server-calculated cancellation offer", async () => {
  db.supportCase.findFirst.mockResolvedValueOnce(
    fixture({ currentNodeId: "start" }),
  );
  expect(
    (
      await runSupportTurn("appointment", "customer", {
        chosenOptionId: "cancel",
      })
    )?.actions,
  ).toEqual([{ kind: "OFFER_CANCEL_REFUND", refundPct: 100 }]);
});
it("hands a human conversation to the canonical append path with its retry identity", async () => {
  db.supportCase.findFirst.mockResolvedValueOnce(
    fixture({ activeChannel: "HUMAN" }),
  );
  await runSupportTurn("appointment", "customer", {
    userMessage: "Please help",
    clientTurnId: "retry-key",
  });
  expect(appendSupportCaseTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      caseId: "case",
      clientTurnId: "retry-key",
      authorUserId: "customer",
      sender: "USER",
    }),
  );
  expect(db.supportCaseMessage.create).not.toHaveBeenCalled();
});
it("a guided-turn retry does not advance the flow or append messages again", async () => {
  db.supportCaseMessage.findUnique.mockResolvedValueOnce({
    id: "committed-turn",
  });
  expect(
    await runSupportTurn("appointment", "customer", {
      chosenOptionId: "cancel",
      clientTurnId: "retry-key",
    }),
  ).toMatchObject({ accepted: true, messages: [] });
  expect(buildSupportContext).not.toHaveBeenCalled();
  expect(db.supportCase.updateMany).not.toHaveBeenCalled();
});
it("refuses a guided exchange when an operator changes the case concurrently", async () => {
  db.supportCase.updateMany.mockResolvedValueOnce({ count: 0 });
  db.supportCase.findUniqueOrThrow.mockResolvedValueOnce(
    fixture({ status: "CLOSED" }),
  );
  expect(
    await runSupportTurn("appointment", "customer", {
      category: "CANCEL_REFUND",
    }),
  ).toMatchObject({
    accepted: false,
    status: "CLOSED",
    messages: [],
    actions: [],
  });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
});
