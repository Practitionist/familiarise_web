/**
 * @jest-environment node
 */

/**
 * A paid consultation parked after a failed restore is cancelled with a full
 * refund once 7 days pass, or 48 h after the released session's original
 * start, whichever is first; the expert takes a strike only when they started
 * the move, and both sides are told.
 */

const mockTransitionConsultation = jest.fn(async (..._a: unknown[]) => {});
const mockTransitionOccurrence = jest.fn(async (..._a: unknown[]) => 1);
const mockStamp = jest.fn(async (_tx: unknown, m: unknown[]) => m.length);
const mockDrive = jest.fn(async (..._a: unknown[]) => ({
  kind: "refunded",
  refund: { refundId: "rf", amountRefundedPaise: 150_000 },
}));
const mockStrike = jest.fn(async (..._a: unknown[]) => true);
const mockStageNotice = jest.fn(async (..._a: unknown[]) => ({
  bells: [],
  emails: [],
}));
const mockFindMany = jest.fn();
const mockPayments = jest.fn();
const mockTransitionParticipant = jest.fn(async (..._a: unknown[]) => 1);
const mockTx = {
  payment: { findMany: (...a: unknown[]) => mockPayments(...a) },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(mockTx),
  },
}));
jest.mock("../../lib/booking/participants", () => ({
  transitionParticipant: (...a: unknown[]) => mockTransitionParticipant(...a),
}));
jest.mock("../../lib/stream/access-revocation", () => ({
  persistSeatRevocation: jest.fn(async () => null),
}));
jest.mock("../../lib/booking/transitions", () => ({
  RESCHEDULE_OPEN_STATUSES: ["PENDING_REVIEW"],
  transitionConsultationRequest: (...a: unknown[]) =>
    mockTransitionConsultation(...a),
  transitionOccurrenceCompletion: (...a: unknown[]) =>
    mockTransitionOccurrence(...a),
}));
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  stampRefundsOwed: (tx: unknown, m: unknown[]) => mockStamp(tx, m),
  driveRefundOwed: (...a: unknown[]) => mockDrive(...a),
}));
jest.mock("../../utils/appointmentlock", () => {
  class AppointmentBusyError extends Error {}
  class BookingLockUnavailableError extends Error {}
  return {
    AppointmentBusyError,
    BookingLockUnavailableError,
    withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
  };
});
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("../../lib/booking/expert-reliability", () => ({
  recordExpertStrike: (...a: unknown[]) => mockStrike(...a),
}));
jest.mock("../../lib/booking/expiry-notices", () => ({
  stageRequestEndedNotice: (...a: unknown[]) => mockStageNotice(...a),
  attemptStagedRequestExpired: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email", () => ({ EMAIL_BUDGET_MS: { JOB: 5_000 } }));
jest.mock("../../lib/observability/run-failures", () => ({
  createRunFailureReporter: () => ({ add: jest.fn(), flush: jest.fn() }),
}));

import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  agedParkedConsultationWhere,
  cancelAgedParkedConsultations,
} from "@/lib/booking/parked-consultation-sweep";
import { persistSeatRevocation } from "@/lib/stream/access-revocation";

const NOW = new Date("2026-11-09T12:00:00Z");
const HOUR = 3_600_000;

function parkedRow(initiatorRole: "CONSULTEE" | "CONSULTANT") {
  return {
    id: "c1",
    appointment: {
      id: "appt-1",
      organizationId: null,
      occurrences: [
        { id: "occ-1", startsAt: new Date(NOW.getTime() - 50 * HOUR) },
      ],
      rescheduleRequests: [{ initiatorRole }],
    },
    requestedBy: { user: { id: "u-buyer", name: "Asha" } },
    consultationPlan: {
      title: "Career call",
      consultantProfileId: "cp-1",
      consultantProfile: { user: { id: "u-expert", name: "Ravi" } },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPayments.mockResolvedValue([
    { id: "pay-1", refundOwedKey: null, refundOwedPaise: null },
  ]);
});

describe("the aged-park predicate", () => {
  it("carries the money, status, open-proposal and both deadlines", () => {
    const where = agedParkedConsultationWhere(NOW);
    expect(where.status).toEqual({ in: ["APPROVED", "SCHEDULED"] });
    expect(where.appointment).toMatchObject({
      payment: { some: { paymentStatus: "SUCCEEDED", deletedAt: null } },
      rescheduleRequests: { none: { status: { in: ["PENDING_REVIEW"] } } },
    });
    const json = JSON.stringify(where);
    // 48 h past the released start, or 7 days past the park.
    expect(json).toContain(new Date(NOW.getTime() - 48 * HOUR).toISOString());
    expect(json).toContain(
      new Date(NOW.getTime() - 7 * 24 * HOUR).toISOString(),
    );
    expect(json).toContain('"none":{"isTentative":false,"deletedAt":null}');
  });
});

describe("cancelAgedParkedConsultations", () => {
  it("cancels with the predicate in the CAS, owes the full balance, and strikes a consultant-started move", async () => {
    mockFindMany.mockResolvedValue([parkedRow("CONSULTANT")]);

    const result = await cancelAgedParkedConsultations({ now: NOW });

    expect(result).toMatchObject({ cancelled: 1, issued: 1, failures: 0 });
    const [, cas] = mockTransitionConsultation.mock.calls[0] as [
      unknown,
      { where: Record<string, unknown>; to: string; fromIn: string[] },
    ];
    expect(cas.to).toBe("CANCELLED");
    expect(cas.fromIn).toEqual(["APPROVED", "SCHEDULED"]);
    expect(cas.where).toEqual({
      id: "c1",
      ...agedParkedConsultationWhere(NOW),
    });
    expect(mockTransitionOccurrence).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        where: {
          appointmentId: "appt-1",
          completionStatus: "RESCHEDULED",
          deletedAt: null,
        },
        to: "CANCELLED",
        data: { deletedAt: NOW },
      }),
    );
    expect(mockTransitionParticipant).toHaveBeenCalledWith(
      mockTx,
      { appointmentId: "appt-1" },
      "CANCELLED",
    );
    expect(mockStamp.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        paymentId: "pay-1",
        amountPaise: null,
        key: "parked-consultation:c1:pay-1",
      }),
    ]);
    expect(mockStrike).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        consultantProfileId: "cp-1",
        cause: "EXPERT_CANCEL",
        occurrenceIds: ["occ-1"],
      }),
    );
    expect(mockStageNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appointmentId: "appt-1" }),
      {
        recipients: ["u-buyer", "u-expert"],
        refundText: expect.any(String),
        refundUserIds: ["u-buyer"],
      },
    );
    expect(mockDrive).toHaveBeenCalledWith(
      expect.objectContaining({ key: "parked-consultation:c1:pay-1" }),
    );
    // The client's Stream access is owed after the commit; the revocation sweep drives it.
    expect(persistSeatRevocation).toHaveBeenCalledWith("appt-1", ["u-buyer"]);
  });

  it("records no strike when the consultee started the move", async () => {
    mockFindMany.mockResolvedValue([parkedRow("CONSULTEE")]);
    await cancelAgedParkedConsultations({ now: NOW });
    expect(mockStrike).not.toHaveBeenCalled();
    expect(mockStamp).toHaveBeenCalled();
  });

  it("drives nothing when the booking moved since the read", async () => {
    mockFindMany.mockResolvedValue([parkedRow("CONSULTANT")]);
    mockTransitionConsultation.mockRejectedValueOnce(
      new IllegalTransitionError("Consultation", "CANCELLED"),
    );
    const result = await cancelAgedParkedConsultations({ now: NOW });
    expect(result).toMatchObject({ cancelled: 0, issued: 0, errors: [] });
    expect(mockStamp).not.toHaveBeenCalled();
    expect(mockDrive).not.toHaveBeenCalled();
    expect(persistSeatRevocation).not.toHaveBeenCalled();
  });

  it("waits when another door's partial refund already holds the payment", async () => {
    mockFindMany.mockResolvedValue([parkedRow("CONSULTEE")]);
    mockPayments.mockResolvedValue([
      { id: "pay-1", refundOwedKey: "occ:x:pay:pay-1", refundOwedPaise: 500 },
    ]);
    const result = await cancelAgedParkedConsultations({ now: NOW });
    expect(result.cancelled).toBe(0);
    expect(result.errors).toEqual([
      expect.stringContaining("Parked consultation c1 waits"),
    ]);
    expect(mockDrive).not.toHaveBeenCalled();
  });

  it("is covered by a full-balance marker another door already holds", async () => {
    mockFindMany.mockResolvedValue([parkedRow("CONSULTEE")]);
    mockPayments.mockResolvedValue([
      {
        id: "pay-1",
        refundOwedKey: "cancel:appt-1:pay-1",
        refundOwedPaise: null,
      },
    ]);
    const result = await cancelAgedParkedConsultations({ now: NOW });
    expect(result.cancelled).toBe(1);
    expect(mockStamp.mock.calls[0][1]).toEqual([]);
    expect(mockDrive).not.toHaveBeenCalled();
  });
});
