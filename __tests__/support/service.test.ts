/**
 * @jest-environment node
 */

/**
 * #appt-support — the orchestrator (runSupportTurn). Mocks prisma + the context
 * builder so this exercises the thread lifecycle wiring: present → advance →
 * resolve, and the escalation hand-off that must create/link a SupportTicket and
 * flip the channel to HUMAN. The resolver/escalation decision logic itself is
 * covered by flowchart-resolver.test.ts.
 */

import type { SupportContext } from "@/lib/support/types";

// jest.mock is hoisted above imports AND local consts, so the factory must build
// the mocks inline (no outer refs → no TDZ). jest.mock resolves via jest's own
// resolver (moduleNameMapper is off) so these use relative paths, even though the
// imports below use the `@/` TS alias.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: jest.fn() },
    appointmentSupportThread: { upsert: jest.fn(), update: jest.fn() },
    supportMessage: { create: jest.fn() },
    supportTicket: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { buildSupportContext } from "@/lib/support/context";
import { runSupportTurn } from "@/lib/support/service";

const mockPrisma = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  appointmentSupportThread: { upsert: jest.Mock; update: jest.Mock };
  supportMessage: { create: jest.Mock };
  supportTicket: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockBuildContext = buildSupportContext as unknown as jest.Mock;

function ctx(overrides: Partial<SupportContext> = {}): SupportContext {
  return {
    threadId: "thread1",
    appointmentId: "appt1",
    userId: "user1",
    organizationId: null,
    appointmentType: "CONSULTATION" as SupportContext["appointmentType"],
    isOrgContext: false,
    isProvider: false,
    startsAt: new Date("2026-09-01T10:00:00Z"),
    refundPctIfCancelledNow: 100,
    paymentId: "pay1",
    paymentAmountPaise: 200_00,
    hasRecording: false,
    ...overrides,
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread1",
    appointmentId: "appt1",
    userId: "user1",
    organizationId: null,
    category: "CANCEL_REFUND",
    status: "OPEN",
    activeChannel: "SELF_SERVE",
    currentNodeId: null,
    supportTicketId: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.appointment.findUnique.mockResolvedValue({ organizationId: null });
  mockBuildContext.mockResolvedValue(ctx());
  // Interactive transaction — run the callback against the same mock surface.
  mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb(mockPrisma),
  );
  mockPrisma.supportMessage.create.mockResolvedValue({});
  mockPrisma.appointmentSupportThread.update.mockResolvedValue({});
});

describe("runSupportTurn", () => {
  it("returns 404-null when the appointment is gone", async () => {
    mockPrisma.appointment.findUnique.mockResolvedValueOnce(null);
    const r = await runSupportTurn("missing", "user1", { category: "CANCEL_REFUND" });
    expect(r).toBeNull();
  });

  it("presents the entry prompt on the first turn (IN_PROGRESS, no action)", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ currentNodeId: null }),
    );
    const r = await runSupportTurn("appt1", "user1", { category: "CANCEL_REFUND" });
    expect(r?.status).toBe("IN_PROGRESS");
    expect(r?.currentNodeId).toBe("start");
    expect(r?.escalated).toBe(false);
    expect(r?.messages[0]?.sender).toBe("BOT");
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
  });

  it("advances to the cancel terminal and requests OFFER_CANCEL_REFUND with the ctx refund %", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ currentNodeId: "start" }),
    );
    const r = await runSupportTurn("appt1", "user1", { chosenOptionId: "cancel" });
    expect(r?.actions).toEqual([{ kind: "OFFER_CANCEL_REFUND", refundPct: 100 }]);
  });

  it("escalates on a human keyword: creates a SupportTicket and flips to HUMAN", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ currentNodeId: "start" }),
    );
    mockPrisma.supportTicket.create.mockResolvedValue({ id: "ticket1" });

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "keep",
      userMessage: "actually I want to talk to a human",
    });

    expect(r?.escalated).toBe(true);
    expect(r?.activeChannel).toBe("HUMAN");
    expect(r?.supportTicketId).toBe("ticket1");
    expect(mockPrisma.supportTicket.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.appointmentSupportThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ESCALATED", activeChannel: "HUMAN" }),
      }),
    );
  });

  it("does not create a second ticket when one is already linked", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ activeChannel: "HUMAN", supportTicketId: "ticket-existing" }),
    );
    const r = await runSupportTurn("appt1", "user1", { userMessage: "any update?" });
    expect(r?.activeChannel).toBe("HUMAN");
    expect(r?.supportTicketId).toBe("ticket-existing");
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
  });

  it("routes an OTHER intent (no self-serve flow) straight to a human", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "OTHER" }),
    );
    mockPrisma.supportTicket.create.mockResolvedValue({ id: "ticket2" });
    const r = await runSupportTurn("appt1", "user1", { category: "OTHER" });
    expect(r?.escalated).toBe(true);
    expect(mockPrisma.supportTicket.create).toHaveBeenCalledTimes(1);
  });
});
