/**
 * @jest-environment node
 */

/**
 * #1280 — the consultant no-show detector auto-refunds in full, and it decides
 * on the ABSENCE of a `MeetingAttendance` row.
 *
 * Those rows are written by `call.session_participant_joined` webhooks. Each
 * party's row arrives in its own delivery, potentially to a different serverless
 * instance. Lose only the consultant's and the predicate "consultee has a row,
 * consultant does not" is satisfied EXACTLY — a full refund against a consultant
 * who was in the call. It is idempotent so it will not double-refund, but
 * reversing it means re-charging a customer by hand.
 *
 * Stream holds the same fact and does not depend on our webhook pipeline having
 * worked, so it is consulted before any money moves.
 */

const mockEvidence = jest.fn();
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockCreateTicket = jest.fn();

jest.mock("../../lib/stream/call-presence", () => ({
  getCallPresenceEvidence: (...a: unknown[]) => mockEvidence(...a),
}));

jest.mock("../../lib/support/create-ticket", () => ({
  createSupportTicket: (...a: unknown[]) => mockCreateTicket(...a),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    supportTicket: { findFirst: (...a: unknown[]) => mockFindFirst(...a) },
    $disconnect: jest.fn(),
  },
}));

jest.mock("@sentry/nextjs", () => ({ captureMessage: jest.fn() }));

import {
  refusalFromStreamEvidence,
  detectBothAbsent,
} from "../../scripts/appointments/detect-consultant-no-shows";

const candidate = (streamCallIds: string[], attendeeIds: string[][] = []) => ({
  id: "consult-1",
  consultationPlan: {
    title: "Career review",
    consultantProfile: { userId: "consultant-1", user: { name: "C" } },
  },
  requestedBy: { userId: "consultee-1", user: { name: "U" } },
  appointment: {
    id: "appt-1",
    organizationId: null,
    slotsOfAppointment: streamCallIds.map((streamCallId, i) => ({
      meetingSession: {
        streamCallId,
        attendances: (attendeeIds[i] ?? []).map((userId) => ({ userId })),
      },
    })),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirst.mockResolvedValue(null);
  mockCreateTicket.mockResolvedValue({ id: "ticket-1" });
});

describe("refusing a no-show refund on Stream's evidence", () => {
  it("refuses when Stream saw both parties — the dropped-webhook false positive", async () => {
    mockEvidence.mockResolvedValue({ unique: 2, maxConcurrent: 2 });
    const refusal = await refusalFromStreamEvidence(
      candidate(["slot-1"]) as never,
    );
    expect(refusal).toContain("2 distinct participants");
  });

  it("refuses when Stream has no report — absence of evidence is not evidence", async () => {
    mockEvidence.mockResolvedValue(null);
    const refusal = await refusalFromStreamEvidence(
      candidate(["slot-1"]) as never,
    );
    expect(refusal).toContain("no report");
  });

  it("refuses when no slot carries a Stream call at all", async () => {
    const c = candidate([]);
    const refusal = await refusalFromStreamEvidence(c as never);
    expect(refusal).toContain("no Stream call");
    expect(mockEvidence).not.toHaveBeenCalled();
  });

  it("allows the refund when Stream corroborates a single participant", async () => {
    mockEvidence.mockResolvedValue({ unique: 1, maxConcurrent: 1 });
    expect(
      await refusalFromStreamEvidence(candidate(["slot-1"]) as never),
    ).toBeNull();
  });

  it("refuses if ANY session of a multi-slot booking shows both parties", async () => {
    mockEvidence
      .mockResolvedValueOnce({ unique: 1, maxConcurrent: 1 })
      .mockResolvedValueOnce({ unique: 2, maxConcurrent: 2 });
    const refusal = await refusalFromStreamEvidence(
      candidate(["slot-1", "slot-2"]) as never,
    );
    expect(refusal).toContain("slot-2");
  });
});

describe("nobody joined — ticket, never an automatic refund", () => {
  it("raises a ticket when neither party joined and Stream saw no one", async () => {
    mockFindMany.mockResolvedValue([candidate(["slot-1"])]);
    mockEvidence.mockResolvedValue({ unique: 0, maxConcurrent: 0 });

    const raised = await detectBothAbsent(new Date(), []);

    expect(raised).toBe(1);
    const ticket = mockCreateTicket.mock.calls[0][0];
    // The consultee paid and got nothing, so the ticket is theirs.
    expect(ticket.userId).toBe("consultee-1");
    expect(ticket.consultationId).toBe("consult-1");
    expect(ticket.description).toContain("NOT auto-refunded");
  });

  it("does not raise a second ticket on the next cron run", async () => {
    mockFindMany.mockResolvedValue([candidate(["slot-1"])]);
    mockEvidence.mockResolvedValue({ unique: 0, maxConcurrent: 0 });
    mockFindFirst.mockResolvedValue({ id: "existing-ticket" });

    expect(await detectBothAbsent(new Date(), [])).toBe(0);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("does not call it both-absent when Stream saw someone", async () => {
    // Our rows are empty, but Stream saw a participant — a lost delivery, not
    // an empty room. Raising a ticket here would blame a session that happened.
    mockFindMany.mockResolvedValue([candidate(["slot-1"])]);
    mockEvidence.mockResolvedValue({ unique: 1, maxConcurrent: 1 });

    expect(await detectBothAbsent(new Date(), [])).toBe(0);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("stays silent when Stream cannot speak for the session either", async () => {
    mockFindMany.mockResolvedValue([candidate(["slot-1"])]);
    mockEvidence.mockResolvedValue(null);

    expect(await detectBothAbsent(new Date(), [])).toBe(0);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("skips a session someone did attend", async () => {
    mockFindMany.mockResolvedValue([candidate(["slot-1"], [["consultee-1"]])]);

    expect(await detectBothAbsent(new Date(), [])).toBe(0);
    expect(mockEvidence).not.toHaveBeenCalled();
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });
});
