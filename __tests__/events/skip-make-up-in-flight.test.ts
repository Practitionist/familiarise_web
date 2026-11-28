/**
 * @jest-environment node
 */

/**
 * #1780 E-3b (QA #1821 case 10) — a refund that throws after its keyed row was
 * written answers that row as in flight, never a bare 500.
 */

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
}));
const findDedupedRefund = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => {
  class RefundValidationError extends Error {}
  return {
    findDedupedRefund: (...a: unknown[]) => findDedupedRefund(...a),
    RefundValidationError,
    RefundKeyReusedError: class extends RefundValidationError {},
  };
});
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn();
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});
jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(),
}));
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: jest.fn(),
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
}));

const DAY = 86_400_000;
/** A case's make-up start, which the make-up read then honours, and what happens while the source read is answered. */
const mockMakeUp: { startsAt: Date | null; whileSourceIsRead: () => void } = {
  startsAt: null,
  whileSourceIsRead: () => {},
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findFirst: async (args: { where: { startsAt?: { gt: Date } } }) => {
        const session = {
          id: "occ-x",
          ordinal: 3,
          startsAt: new Date(Date.now() - DAY),
        };
        const after = args.where.startsAt?.gt;
        // Only the make-up read filters on a start.
        if (!after) {
          mockMakeUp.whileSourceIsRead();
          return session;
        }
        return !mockMakeUp.startsAt || mockMakeUp.startsAt > after
          ? session
          : null;
      },
      findMany: async () =>
        [1, 2, 3, 4].map((ordinal) => ({
          ordinal,
          startsAt: new Date(Date.now() + (ordinal - 3) * DAY),
          endsAt: new Date(Date.now() + (ordinal - 3) * DAY + 3_600_000),
          completionStatus: "SCHEDULED",
          movedAt: null,
          hostCancelledAt: null,
        })),
    },
    appointment: {
      findUnique: async () => ({ class: { classPlan: { totalSessions: 4 } } }),
    },
    appointmentParticipant: {
      findFirst: async () => ({ createdAt: new Date(Date.now() - 30 * DAY) }),
    },
    payment: {
      findFirst: async () => ({
        id: "pay-1",
        amount: 40_000,
        createdAt: new Date(Date.now() - 30 * DAY),
        paymentIntent: "pay_rzp",
      }),
    },
  },
}));

import { skipClassMakeUp } from "../../lib/booking/class-sessions";

it("answers the keyed refund as PENDING when the refund throws after reserving it", async () => {
  refundBookingPayment.mockRejectedValue(new Error("gateway timeout"));
  findDedupedRefund.mockResolvedValue({
    refundId: "rf-1",
    amountRefundedPaise: 10_000,
    status: "PENDING",
  });
  await expect(
    skipClassMakeUp({
      appointmentId: "appt-1",
      sourceOccurrenceId: "occ-src",
      userId: "u-1",
    }),
  ).resolves.toEqual({
    refundId: "rf-1",
    amountRefundedPaise: 10_000,
    rail: "GATEWAY",
    status: "PENDING",
  });
  expect(findDedupedRefund).toHaveBeenCalledWith("occ:occ-src:pay:pay-1", {
    paymentId: "pay-1",
    amountPaise: 10_000,
  });
});

it("refuses the skip when an operator's other-amount refund already holds the session key", async () => {
  const { RefundKeyReusedError } = jest.requireMock(
    "../../lib/payments/operations/refund",
  ) as { RefundKeyReusedError: new () => Error };
  refundBookingPayment.mockRejectedValue(new RefundKeyReusedError());
  // The operator's ₹50 session refund under the same occurrence key.
  findDedupedRefund.mockResolvedValue({
    refundId: "rf-ops",
    amountRefundedPaise: 5_000,
    status: "SUCCEEDED",
  });

  await expect(
    skipClassMakeUp({
      appointmentId: "appt-1",
      sourceOccurrenceId: "occ-src",
      userId: "u-1",
    }),
  ).rejects.toMatchObject({ code: "MAKEUP_NOT_SKIPPABLE" });
  expect(findDedupedRefund).not.toHaveBeenCalled();
});

it("refuses a skip whose read of the missed session outlasts the make-up's start: the start is judged after the reads, not before them", async () => {
  const lockTaken = new Date("2026-12-01T09:59:59.750Z");
  jest.useFakeTimers({ now: lockTaken });
  try {
    refundBookingPayment.mockReset();
    mockMakeUp.startsAt = new Date("2026-12-01T10:00:00.000Z");
    // The source read takes 450 ms, so it answers after the make-up began.
    mockMakeUp.whileSourceIsRead = () =>
      jest.setSystemTime(new Date("2026-12-01T10:00:00.200Z"));

    await expect(
      skipClassMakeUp({
        appointmentId: "appt-1",
        sourceOccurrenceId: "occ-src",
        userId: "u-1",
      }),
    ).rejects.toMatchObject({ code: "MAKEUP_NOT_SKIPPABLE" });
    expect(refundBookingPayment).not.toHaveBeenCalled();
  } finally {
    mockMakeUp.startsAt = null;
    mockMakeUp.whileSourceIsRead = () => {};
    jest.useRealTimers();
  }
});
