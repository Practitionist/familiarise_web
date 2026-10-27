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

jest.mock("../../lib/stream/call-presence", () => ({
  getCallPresenceEvidence: (...a: unknown[]) => mockEvidence(...a),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: async (_args: unknown, report: () => void) => {
    report();
    return true;
  },
}));

const mockCapture = jest.fn();
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureMessage: (...a: unknown[]) => mockCapture(...a),
}));

import { refusalFromStreamEvidence } from "../../scripts/appointments/detect-consultant-no-shows";

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
    occurrences: streamCallIds.map((streamCallId, i) => ({
      meeting: {
        streamCallId,
        attendances: (attendeeIds[i] ?? []).map((userId) => ({ userId })),
      },
    })),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
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
