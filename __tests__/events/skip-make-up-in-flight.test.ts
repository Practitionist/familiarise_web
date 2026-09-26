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
  fundingRailForIntent: () => "GATEWAY",
}));
const findDedupedRefund = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => ({
  findDedupedRefund: (...a: unknown[]) => findDedupedRefund(...a),
  RefundValidationError: class extends Error {},
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
}));
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
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findFirst: async () => ({
        id: "occ-x",
        ordinal: 3,
        startsAt: new Date(Date.now() - DAY),
      }),
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
  expect(findDedupedRefund).toHaveBeenCalledWith("occ:occ-src:pay:pay-1");
});
