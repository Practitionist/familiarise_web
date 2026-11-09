/**
 * @jest-environment node
 */

/**
 * A host's conduct removal: the seat is released and recorded in one
 * transaction, support opens a case, the seat's earnings are held and NO refund
 * is made here. Stream follows after the commit.
 */
const mockTx = {
  participantRemoval: {
    upsert: jest.fn(async (..._args: unknown[]) => ({ id: "rem-1" })),
    update: jest.fn(async (..._args: unknown[]) => ({})),
  },
  payment: { findFirst: jest.fn() },
  supportCase: {
    update: jest.fn(async (..._args: unknown[]) => ({ messageSeq: 2 })),
  },
  supportCaseMessage: { create: jest.fn(async (..._args: unknown[]) => ({})) },
  supportCaseEvent: { create: jest.fn(async (..._args: unknown[]) => ({})) },
};
const mockPrisma = {
  appointment: { findFirst: jest.fn() },
  $transaction: jest.fn(async (fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  ),
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockPrisma }));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: <T>(fn: () => Promise<T>) => fn(),
}));
jest.mock("@/utils/appointmentlock", () => ({
  renewAppointmentLock: jest.fn(),
  withAppointmentLock: (_id: string, fn: (lock: unknown) => unknown) => fn({}),
}));
jest.mock("@/lib/api/after-safe", () => ({
  scheduleAfter: jest.fn(async (fn: () => Promise<void>) => fn()),
}));

const mockRelease = jest.fn();
jest.mock("@/lib/booking/participants", () => ({
  releaseParticipant: (...args: unknown[]) => mockRelease(...args),
}));
const mockStageSeatOpened = jest.fn(async (..._args: unknown[]) => null);
jest.mock("@/lib/booking/event-waitlist", () => ({
  stageSeatOpenedNotices: (...args: unknown[]) => mockStageSeatOpened(...args),
  finishSeatOpenedNotices: jest.fn(async () => undefined),
}));
const mockOpenCase = jest.fn();
jest.mock("@/lib/support/removal-case", () => ({
  openRemovalCaseTx: (...args: unknown[]) => mockOpenCase(...args),
}));
const mockHold = jest.fn();
jest.mock("@/lib/support/case-holds", () => ({
  holdPaymentForCase: (...args: unknown[]) => mockHold(...args),
}));
const mockKick = jest.fn();
const mockEnqueueKick = jest.fn();
const mockRevokeChat = jest.fn();
jest.mock("@/lib/stream/access-revocation", () => ({
  kickUserFromAppointmentCalls: (...args: unknown[]) => mockKick(...args),
  enqueueCallKickRetry: (...args: unknown[]) => mockEnqueueKick(...args),
  revokeEndedEventChatAccess: (...args: unknown[]) => mockRevokeChat(...args),
}));
const mockRefund = jest.fn();
jest.mock("@/lib/payments/operations/event-refunds", () => ({
  refundRemovedAttendeeSeat: (...args: unknown[]) => mockRefund(...args),
}));

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";

// Loaded lazily: the module reads the mocks above when it is first required.
const removeParticipantForConduct = async (
  input: Parameters<
    typeof import("@/lib/booking/participant-removal").removeParticipantForConduct
  >[0],
) =>
  (
    await import("@/lib/booking/participant-removal")
  ).removeParticipantForConduct(input);

const INPUT = {
  appointmentId: "appt-1",
  targetUserId: "attendee-1",
  actor: { userId: "host-1", role: "HOST" as const },
  reason: "DISRUPTIVE" as const,
  note: " shouting over the speaker ",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.appointment.findFirst.mockResolvedValue({
    id: "appt-1",
    webinar: { id: "web-1", webinarPlan: { title: "Intro to SIPs" } },
    class: null,
  });
  mockRelease.mockResolvedValue(1);
  mockOpenCase.mockResolvedValue({ id: "case-1", referenceNumber: "TKT-1" });
  mockHold.mockResolvedValue({});
  mockKick.mockResolvedValue(true);
  mockTx.payment.findFirst.mockResolvedValue({
    id: "pay-1",
    refundOwedKey: null,
  });
});

describe("removeParticipantForConduct", () => {
  it("refuses an appointment that is not a webinar or class", async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue({
      id: "appt-1",
      webinar: null,
      class: null,
    });
    await expect(removeParticipantForConduct(INPUT)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
    await expect(removeParticipantForConduct(INPUT)).rejects.toBeInstanceOf(
      BookingRuleError,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("is a no-op when the attendee has no live seat (repeat request)", async () => {
    mockRelease.mockResolvedValue(0);
    await expect(removeParticipantForConduct(INPUT)).resolves.toBeNull();
    expect(mockTx.participantRemoval.upsert).not.toHaveBeenCalled();
    expect(mockOpenCase).not.toHaveBeenCalled();
    expect(mockKick).not.toHaveBeenCalled();
    expect(mockRevokeChat).not.toHaveBeenCalled();
  });

  it("releases only an attendee seat and passes the transaction to every helper", async () => {
    await removeParticipantForConduct(INPUT);
    expect(mockRelease).toHaveBeenCalledWith(mockTx, {
      appointmentId: "appt-1",
      userId: "attendee-1",
      role: "CONSULTEE",
    });
    expect(mockOpenCase.mock.calls[0][0]).toBe(mockTx);
    expect(mockHold.mock.calls[0][0]).toBe(mockTx);
    expect(mockStageSeatOpened.mock.calls[0][0]).toBe(mockTx);
  });

  it("records who and why, opens the case with the host's trimmed note, and links them", async () => {
    const result = await removeParticipantForConduct(INPUT);
    expect(mockTx.participantRemoval.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          appointmentId: "appt-1",
          userId: "attendee-1",
          removedByUserId: "host-1",
          actorRole: "HOST",
          reason: "DISRUPTIVE",
          note: "shouting over the speaker",
        }),
        update: expect.objectContaining({
          status: "PENDING_REVIEW",
          decidedAt: null,
        }),
      }),
    );
    expect(mockOpenCase.mock.calls[0][1]).toMatchObject({
      appointmentId: "appt-1",
      removedUserId: "attendee-1",
      eventTitle: "Intro to SIPs",
      reasonLabel: "Disrupting the session",
      note: "shouting over the speaker",
    });
    expect(mockTx.participantRemoval.update).toHaveBeenCalledWith({
      where: { id: "rem-1" },
      data: { supportCaseId: "case-1" },
    });
    expect(result).toEqual({
      removalId: "rem-1",
      caseId: "case-1",
      caseReference: "TKT-1",
      earningsHeld: true,
    });
  });

  it("holds the seat's earnings and does NOT refund", async () => {
    await removeParticipantForConduct(INPUT);
    expect(mockHold).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ caseId: "case-1", paymentId: "pay-1" }),
    );
    expect(mockTx.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseId: "case-1",
        kind: "HOLD_APPLIED",
        toValue: "pay-1",
      }),
    });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it("leaves a payment another refund door already owes alone", async () => {
    mockTx.payment.findFirst.mockResolvedValue({
      id: "pay-1",
      refundOwedKey: "seat-leave:x",
    });
    const result = await removeParticipantForConduct(INPUT);
    expect(mockHold).not.toHaveBeenCalled();
    expect(result?.earningsHeld).toBe(false);
  });

  it("still removes the attendee when a payout in flight refuses the hold, and tells staff", async () => {
    mockHold.mockRejectedValue(
      new OpsRefusal("PAYOUT_IN_FLIGHT", "A linked payout is being sent."),
    );
    const result = await removeParticipantForConduct(INPUT);
    expect(result?.earningsHeld).toBe(false);
    expect(mockTx.supportCaseMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseId: "case-1",
        seq: 2,
        isInternal: true,
        body: expect.stringContaining("PAYOUT_IN_FLIGHT"),
      }),
    });
  });

  it("does not swallow an unexpected hold failure", async () => {
    mockHold.mockRejectedValue(new Error("db down"));
    await expect(removeParticipantForConduct(INPUT)).rejects.toThrow("db down");
  });

  it("kicks from open calls, then removes the event channel", async () => {
    await removeParticipantForConduct(INPUT);
    expect(mockKick).toHaveBeenCalledWith("appt-1", "attendee-1");
    expect(mockRevokeChat).toHaveBeenCalledWith("webinar", "web-1", [
      "attendee-1",
    ]);
    expect(mockEnqueueKick).not.toHaveBeenCalled();
    expect(mockKick.mock.invocationCallOrder[0]).toBeLessThan(
      mockRevokeChat.mock.invocationCallOrder[0],
    );
  });

  it("queues the call kick for retry when Stream refuses it, without failing the removal", async () => {
    mockKick.mockResolvedValue(false);
    const result = await removeParticipantForConduct(INPUT);
    expect(mockEnqueueKick).toHaveBeenCalledWith("appt-1", "attendee-1");
    expect(mockRevokeChat).toHaveBeenCalled();
    expect(result?.removalId).toBe("rem-1");
  });
});
