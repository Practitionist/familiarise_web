/**
 * @jest-environment node
 */

/**
 * #appt-support — the orchestrator (runSupportTurn). Mocks prisma + the context
 * builder so this exercises the canonical case lifecycle wiring: present →
 * advance → resolve, and the escalation hand-off that must flip the ONE
 * canonical SupportCase to HUMAN. The resolver/escalation decision logic itself
 * is covered by flowchart-resolver.test.ts.
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
    supportCase: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseMessage: { create: jest.fn(), findMany: jest.fn() },
    supportCaseEvent: { create: jest.fn(), findMany: jest.fn() },
    supportFlowOutcome: { create: jest.fn() },
    supportTicketCounter: { upsert: jest.fn() },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    organization: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(),
}));
// The ops notifications are a different seam: they page people and send mail.
// This suite is about the case lifecycle, so the bells stay out of it.
jest.mock("../../lib/support/create-ticket", () => ({
  __esModule: true,
  notifyRequesterOfTicket: jest.fn(async () => undefined),
  notifySupportStaff: jest.fn(async () => undefined),
  notifyStaffOfTicketActivity: jest.fn(async () => undefined),
}));

import prisma from "@/lib/prisma";
import { buildSupportContext } from "@/lib/support/context";
import { runSupportTurn } from "@/lib/support/service";

const mockPrisma = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  supportCase: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  supportCaseMessage: { create: jest.Mock; findMany: jest.Mock };
  supportCaseEvent: { create: jest.Mock; findMany: jest.Mock };
  supportFlowOutcome: { create: jest.Mock };
  supportTicketCounter: { upsert: jest.Mock };
  user: { findMany: jest.Mock; findUnique: jest.Mock };
  organization: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};
const mockBuildContext = buildSupportContext as unknown as jest.Mock;

/** The one canonical case per (appointment, user). */
const CASE_ID = "case1";
const CASE_UPDATED_AT = new Date("2026-09-01T09:00:00Z");

function ctx(overrides: Partial<SupportContext> = {}): SupportContext {
  return {
    threadId: CASE_ID,
    appointmentId: "appt1",
    userId: "user1",
    organizationId: null,
    appointmentType: "CONSULTATION" as SupportContext["appointmentType"],
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
    planTitle: null,
    ...overrides,
  };
}

/** The canonical SupportCase row every turn reads and writes. */
function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    referenceNumber: "FAM-2026-000001",
    clientIntakeId: "appointment:appt1:user1",
    title: "Appointment support",
    description: "Appointment help requested",
    category: "CANCEL_REFUND",
    flowKey: null,
    currentNodeId: null,
    activeChannel: "SELF_SERVE",
    issueType: null,
    priority: "MEDIUM",
    status: "OPEN",
    caseKind: "INCIDENT",
    requesterUserId: "user1",
    submitterUserId: "user1",
    organizationId: null,
    appointmentId: "appt1",
    assignedToId: null,
    ackDueAt: null,
    acknowledgedAt: null,
    resolutionDueAt: null,
    resolvedAt: null,
    closedAt: null,
    deletedAt: null,
    firstAgentReplyAt: null,
    awaitingUserSince: null,
    pausedSeconds: 0,
    messageSeq: 0,
    lastMessageAt: null,
    createdAt: CASE_UPDATED_AT,
    updatedAt: CASE_UPDATED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.appointment.findUnique.mockResolvedValue({
    id: "appt1",
    appointmentType: "CONSULTATION",
    organizationId: null,
  });
  mockBuildContext.mockResolvedValue(ctx());
  // Interactive transaction — run the callback against the same mock surface;
  // array form (persistHumanTurn) resolves each element.
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg as Promise<unknown>[])
      : (arg as (tx: unknown) => unknown)(mockPrisma),
  );
  // The canonical case: one row per (appointment, user), read back by the
  // intake lookup, by the escalation read and by the final receipt read.
  mockPrisma.supportCase.findFirst.mockResolvedValue(caseRow());
  mockPrisma.supportCase.findUnique.mockResolvedValue(caseRow());
  mockPrisma.supportCase.findUniqueOrThrow.mockResolvedValue(caseRow());
  mockPrisma.supportCase.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) =>
      caseRow({ ...args.data, id: CASE_ID }),
  );
  // The case row is also the message-sequence allocator, so every write path
  // reads `messageSeq` back off this update.
  mockPrisma.supportCase.update.mockResolvedValue({ messageSeq: 1 });
  mockPrisma.supportCase.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.supportCaseMessage.create.mockResolvedValue({ id: "m1" });
  mockPrisma.supportCaseMessage.findMany.mockResolvedValue([]);
  mockPrisma.supportCaseEvent.create.mockResolvedValue({ id: "e1" });
  mockPrisma.supportFlowOutcome.create.mockResolvedValue({ id: "out-1" });
  mockPrisma.supportTicketCounter.upsert.mockResolvedValue({ nextSeq: 2 });
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user1", name: "Riya" });
  mockPrisma.organization.findUnique.mockResolvedValue({ name: "Acme" });
});

describe("runSupportTurn", () => {
  it("returns 404-null when the appointment is gone", async () => {
    mockPrisma.appointment.findUnique.mockResolvedValueOnce(null);
    const r = await runSupportTurn("missing", "user1", {
      category: "CANCEL_REFUND",
    });
    expect(r).toBeNull();
  });

  it("presents the entry prompt on the first turn (IN_PROGRESS, no action)", async () => {
    const r = await runSupportTurn("appt1", "user1", {
      category: "CANCEL_REFUND",
    });
    expect(r?.status).toBe("IN_PROGRESS");
    expect(r?.currentNodeId).toBe("start");
    expect(r?.escalated).toBe(false);
    expect(r?.messages[0]?.sender).toBe("BOT");
    // The case stayed on the bot: no hand-off, and no second case row minted
    // beside the canonical one.
    expect(r?.activeChannel).toBe("SELF_SERVE");
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activeChannel: "SELF_SERVE",
          status: "IN_PROGRESS",
        }),
      }),
    );
    expect(mockPrisma.supportCase.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeChannel: "HUMAN" }),
      }),
    );
  });

  it("advances to the cancel terminal and requests OFFER_CANCEL_REFUND with the ctx refund %", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ currentNodeId: "start" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });
    expect(r?.actions).toEqual([
      { kind: "OFFER_CANCEL_REFUND", refundPct: 100 },
    ]);
  });

  it("escalates on a human keyword: flips the canonical case to HUMAN", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ currentNodeId: "start" }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "keep",
      userMessage: "actually I want to talk to a human",
    });

    expect(r?.escalated).toBe(true);
    expect(r?.activeChannel).toBe("HUMAN");
    // The hand-off is the SAME case row — there is no second ticket any more.
    expect(r?.supportTicketId).toBe(CASE_ID);
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
    // updateMany, not update: the flip is compare-and-set so a case staff have
    // CLOSED cannot be reopened behind their back.
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: CASE_ID,
          closedAt: null,
          deletedAt: null,
        }),
        data: expect.objectContaining({
          status: "ESCALATED",
          activeChannel: "HUMAN",
        }),
      }),
    );
    // The handoff brief the staff queue reads is written onto the case.
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining("Escalation reason:"),
        }),
      }),
    );
  });

  it("does not mint a second case when the hand-off already happened", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ activeChannel: "HUMAN", status: "ESCALATED" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "any update?",
    });
    expect(r?.activeChannel).toBe("HUMAN");
    expect(r?.supportTicketId).toBe(CASE_ID);
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
  });

  it("refuses the write when the CAS matches no row, and says so", async () => {
    // The refusal path: staff closed the case, so `persistHumanTurn`'s
    // guarded updateMany matches nothing. The contract is `accepted: false`
    // plus the case's REAL status, and no message row — useSupportThread keys
    // its "your message wasn't sent" recovery on exactly `accepted === false`,
    // so this branch silently regressing is what puts a delivered-looking
    // bubble on a closed case.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        activeChannel: "HUMAN",
        status: "CLOSED",
        closedAt: new Date("2026-09-01T09:30:00Z"),
      }),
    );
    mockPrisma.supportCase.updateMany.mockResolvedValue({
      count: 0,
    });

    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "are you still there?",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.status).toBe("CLOSED");
    expect(mockPrisma.supportCaseMessage.create).not.toHaveBeenCalled();
    // The guard was expressed in the WHERE, so the database refused the write.
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ closedAt: null, deletedAt: null }),
      }),
    );
  });

  it("routes an OTHER intent (no self-serve flow) straight to a human", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "OTHER" }),
    );
    const r = await runSupportTurn("appt1", "user1", { category: "OTHER" });
    expect(r?.escalated).toBe(true);
    expect(r?.supportTicketId).toBe(CASE_ID);
    // Same row, escalated in place — no second case beside it.
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ESCALATED",
          activeChannel: "HUMAN",
        }),
      }),
    );
  });

  it("restarts at the entry when the persisted cursor no longer exists (flow-version drift)", async () => {
    // Pre-hub cases carry cursors from older registry revisions; a ghost
    // cursor used to make every choice mismatch and re-present forever.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "CANCEL_REFUND", currentNodeId: "ghost-node" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });
    expect(r?.currentNodeId).toBe("start"); // presented the CURRENT entry…
    expect(r?.escalated).toBe(false); // …not failed safe to a human
    expect(mockPrisma.supportCaseMessage.create).toHaveBeenCalledTimes(1);
  });

  it("answers instead of going silent when nothing matched, keeping the chips live", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "CANCEL_REFUND", currentNodeId: "start" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "bogus",
    });
    expect(r?.currentNodeId).toBe("start"); // cursor did not move
    // Exactly one bubble, and it is NOT a verbatim repeat of the prompt: this
    // used to persist nothing at all, so a user who typed at a prompt watched
    // their message land and the bot say nothing back.
    const bodies = mockPrisma.supportCaseMessage.create.mock.calls.map(
      (c) => c[0].data,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].sender).toBe("BOT");
    expect(bodies[0].body).toMatch(/didn't catch that/i);
    // The options ride along, or the prompt becomes a dead end — no buttons,
    // and free text cannot advance it.
    expect(bodies[0].metadata.options.length).toBeGreaterThan(0);
    expect(bodies[0].metadata.nodeId).toBe("start");
  });

  it("records the intent chip as the user's first message", async () => {
    // The walk can only name an option it matched, and the entry present()
    // matches nothing — so the transcript opened with a bot prompt and no
    // record of what the user had actually asked for.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "CANCEL_REFUND", currentNodeId: null }),
    );
    await runSupportTurn("appt1", "user1", { category: "CANCEL_REFUND" });
    const written = mockPrisma.supportCaseMessage.create.mock.calls.map(
      (c) => c[0].data,
    );
    expect(written[0].sender).toBe("USER");
    expect(written[0].body).toBeTruthy();
    expect(written[1].sender).toBe("BOT");
  });

  it("does not scold the user for typing the word the nudge told them to type", async () => {
    // "agent" matches no option, so the walk emits "I didn't catch that…" —
    // which is the very copy telling them to type "agent". Escalating while
    // persisting that message left the transcript contradicting itself one line
    // above the hand-off.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "CANCEL_REFUND", currentNodeId: "start" }),
    );
    const r = await runSupportTurn("appt1", "user1", { userMessage: "agent" });
    expect(r?.escalated).toBe(true);

    const bodies = mockPrisma.supportCaseMessage.create.mock.calls.map(
      (c) => c[0].data,
    );
    // The user's own words are still recorded…
    expect(bodies.some((b) => b.sender === "USER" && b.body === "agent")).toBe(
      true,
    );
    // …but nothing tells them it wasn't understood.
    expect(bodies.some((b) => /didn't catch that/i.test(b.body))).toBe(false);
  });

  it("clicking the active intent chip restarts the flow at its entry", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "CANCEL_REFUND", currentNodeId: "confirm" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      category: "CANCEL_REFUND",
    });
    expect(r?.currentNodeId).toBe("start");
    expect(r?.status).toBe("IN_PROGRESS");
  });

  it("clamps an org party to the org-party intents (defensive, route 403s first)", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "OTHER", currentNodeId: null }),
    );
    mockBuildContext.mockResolvedValue(
      ctx({ isOrgContext: true, isOrgOperator: true, organizationId: "org1" }),
    );

    // A participant-only intent reaching the service from an org party is
    // clamped to ORG_ADMIN_DISPUTE — which has a self-serve flow, so the turn
    // proceeds on THAT flow instead of the smuggled one.
    const r = await runSupportTurn("appt1", "user1", {
      category: "CANCEL_REFUND",
      isOrgParty: true,
    });
    expect(r?.escalated).toBe(false);
    // The clamped flow self-serves — no hand-off may be filed for the
    // smuggled intent.
    expect(r?.activeChannel).toBe("SELF_SERVE");
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeChannel: "SELF_SERVE" }),
      }),
    );
    expect(mockPrisma.supportCase.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeChannel: "HUMAN" }),
      }),
    );
    // The self-serve status write is a GUARDED updateMany, not a bare update.
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "ORG_ADMIN_DISPUTE" }),
      }),
    );
  });

  it("refuses a self-serve turn on a CLOSED case instead of reopening it", async () => {
    // The asymmetry that made this reachable: `persistHumanTurn` has always
    // CAS'd, so an escalated message could not land on a settled case, while
    // the self-serve path wrote `status` unconditionally and quietly reopened
    // what staff had closed. Same door, two rules.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        category: "CANCEL_REFUND",
        status: "CLOSED",
        closedAt: new Date("2026-09-01T09:30:00Z"),
      }),
    );
    mockPrisma.supportCase.updateMany.mockResolvedValue({
      count: 0,
    });
    mockPrisma.supportCase.findUniqueOrThrow.mockResolvedValue(
      caseRow({ status: "CLOSED" }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.status).toBe("CLOSED");
    // Nothing is echoed back: a bot reply rendered for a turn that rolled back
    // is how a refused message ends up looking delivered.
    expect(r?.messages).toEqual([]);
    expect(r?.resolved).toBe(false);
    // The whole point of CAS-ing first: the refusal wrote NOTHING. The
    // assertions above pass just as well when the messages were inserted and
    // then survived a `return false`, which is the regression this test exists
    // for.
    expect(mockPrisma.supportCaseMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
  });

  it("still lets a RESOLVED case be picked up again", async () => {
    // Deliberately NOT refused. RESOLVED means the bot answered the question;
    // with one case per booking, refusing it would leave someone who
    // resolved one question unable to ask a second.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        category: "CANCEL_REFUND",
        status: "RESOLVED",
        resolvedAt: new Date("2026-09-01T09:00:00Z"),
      }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });

    expect(r?.accepted).not.toBe(false);
    // The case moved on from RESOLVED instead of staying settled.
    expect(r?.status).toBe("IN_PROGRESS");
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ closedAt: null, deletedAt: null }),
      }),
    );
  });

  it("reopens the reused case when a RESOLVED human case re-escalates on a new intent", async () => {
    // Staff RESOLVE mirrors onto the case and keeps the link. A new intent
    // with no self-serve flow escalates straight back onto that case, which
    // must return to the queue rather than stay RESOLVED with its clock
    // stopped.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        activeChannel: "HUMAN",
        status: "RESOLVED",
        resolvedAt: new Date("2026-09-01T09:00:00Z"),
      }),
    );

    const r = await runSupportTurn("appt1", "user1", { category: "OTHER" });

    expect(r?.escalated).toBe(true);
    expect(r?.supportTicketId).toBe(CASE_ID);
    // The SAME row was reopened — a second case would be a second queue item.
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: CASE_ID,
          closedAt: null,
          deletedAt: null,
        }),
        data: expect.objectContaining({
          status: "ESCALATED",
          activeChannel: "HUMAN",
          resolvedAt: null,
        }),
      }),
    );
  });

  it("raises the reused case to HIGH when the re-escalation is urgent", async () => {
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        activeChannel: "HUMAN",
        status: "RESOLVED",
        priority: "MEDIUM",
        resolvedAt: new Date("2026-09-01T09:00:00Z"),
      }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      category: "OTHER",
      urgent: true,
    });

    expect(r?.supportTicketId).toBe(CASE_ID);
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: "HIGH" }),
      }),
    );
  });

  it("reopens from the row, not the pre-transaction read, on a human reply", async () => {
    // The case was read as ESCALATED; if staff resolve it before the
    // transaction runs, the reply must still reopen it. The reopen is
    // therefore unconditional and the case's own status is the CAS.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        activeChannel: "HUMAN",
        status: "ESCALATED",
      }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "still broken",
    });

    expect(r?.accepted).toBe(true);
    expect(r?.status).toBe("ESCALATED");
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: CASE_ID,
          closedAt: null,
          deletedAt: null,
        }),
        data: expect.objectContaining({
          status: "ESCALATED",
          resolvedAt: null,
        }),
      }),
    );
    // One case, reopened in place — no second row beside it.
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
  });

  it("refuses an ESCALATING turn on a CLOSED case, and mints no second case", async () => {
    // The third door. The self-serve path and `persistHumanTurn` both CAS'd;
    // `escalate()` did not, so any intent chip reopened a case staff had
    // closed — and worse than on the other two paths, because the reopen ALSO
    // minted a second case with its own reference and its own SLA clock while
    // the first sat resolved in the queue.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({
        category: "CANCEL_REFUND",
        status: "CLOSED",
        closedAt: new Date("2026-09-01T09:30:00Z"),
      }),
    );
    mockPrisma.supportCase.findUniqueOrThrow.mockResolvedValue(
      caseRow({
        status: "CLOSED",
        closedAt: new Date("2026-09-01T09:30:00Z"),
      }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "I want to speak to a human",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.escalated).toBe(false);
    expect(r?.status).toBe("CLOSED");
    // The case keeps its identity — no new row, nothing echoed.
    expect(r?.supportTicketId).toBe(CASE_ID);
    expect(r?.messages).toEqual([]);
    // And nothing landed: no transcript row, no second case minted.
    expect(mockPrisma.supportCaseMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
    // The closed case was not touched at all.
    expect(mockPrisma.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an escalation whose guarded write matches no row, with the guard in the WHERE", async () => {
    // The case is still open, but the row changed under the read (staff
    // closed it mid-turn), so the compare-and-set matched nothing. The guard
    // is expressed in the WHERE, not only checked in JS.
    mockPrisma.supportCase.findFirst.mockResolvedValue(
      caseRow({ category: "CANCEL_REFUND" }),
    );
    mockPrisma.supportCase.updateMany.mockResolvedValue({ count: 0 });

    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "I want to speak to a human",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.escalated).toBe(false);
    expect(r?.messages).toEqual([]);
    expect(mockPrisma.supportCaseMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ closedAt: null, deletedAt: null }),
      }),
    );
  });

  it("attributes the canonical case to the appointment's organization", async () => {
    mockPrisma.appointment.findUnique.mockResolvedValue({
      id: "appt1",
      appointmentType: "CONSULTATION",
      organizationId: "org9",
    });
    // No case yet: the intake creates the ONE canonical row, attributed to
    // the org the seat was booked under.
    mockPrisma.supportCase.findFirst.mockResolvedValue(null);
    mockBuildContext.mockResolvedValue(
      ctx({
        isOrgContext: true,
        isOrgOperator: false,
        organizationId: "org9",
        stage: "COMPLETED",
        paymentId: "pay9",
      }),
    );

    await runSupportTurn("appt1", "user1", { category: "NO_SHOW" });

    expect(mockPrisma.supportCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org9",
          appointmentId: "appt1",
          clientIntakeId: "appointment:appt1:user1",
        }),
      }),
    );
  });

  it("escalates a provider no-show at HIGH on the canonical case", async () => {
    // Turn one opened the case at the NO_SHOW entry prompt; turn two takes
    // the "the expert never showed up" chip, whose terminal escalates.
    mockPrisma.supportCase.findFirst
      .mockResolvedValueOnce(null) // turn 1: the intake lookup
      .mockResolvedValueOnce(null) // turn 1: clientIntakeId dedupe
      .mockResolvedValueOnce(null) // turn 1: open-scope dedupe
      .mockResolvedValueOnce(
        caseRow({ category: "NO_SHOW", currentNodeId: "start" }),
      ); // turn 2
    mockBuildContext.mockResolvedValue(
      ctx({
        isOrgContext: true,
        isOrgOperator: false,
        organizationId: "org9",
        stage: "COMPLETED",
        paymentId: "pay9",
      }),
    );

    await runSupportTurn("appt1", "user1", { category: "NO_SHOW" });
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "expert",
    });

    expect(r?.escalated).toBe(true);
    expect(r?.supportTicketId).toBe(CASE_ID);
    expect(mockPrisma.supportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priority: "HIGH", // provider_no_show maps HIGH in the shared policy
          issueType: "CONSULTANT_NO_SHOW",
        }),
      }),
    );
  });
});
