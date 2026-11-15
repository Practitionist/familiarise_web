/**
 * @jest-environment node
 */

/**
 * The multiple-refundable-payments alarm in resolveBookingRefundContext is
 * written on the caller's client and awaited, so inside a cancel transaction it
 * neither queues behind the transaction on a one-connection pool nor outlives
 * the commit.
 */

const mockAlarm = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: (...a: unknown[]) => mockAlarm(...a),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";

it("records the alarm with the transaction client it was handed", async () => {
  const payment = (id: string) => ({
    id,
    amount: 50_000,
    paymentIntent: `order_${id}`,
    refunds: [],
    disputes: [],
  });
  const tx = {
    appointment: {
      findFirst: jest.fn(async () => ({
        id: "appt-1",
        cancellationPolicy: null,
        payment: [payment("pay-1"), payment("pay-2")],
        subscription: null,
        occurrences: [],
      })),
    },
    refund: { findMany: jest.fn(async () => []) },
    appointmentOccurrence: { findMany: jest.fn(async () => []) },
    rescheduleRequest: { findMany: jest.fn(async () => []) },
  };

  const ctx = await resolveBookingRefundContext(
    { consultationId: "c-1" },
    undefined,
    tx as never,
  );

  expect(ctx.paidPayment?.id).toBe("pay-1");
  expect(mockAlarm).toHaveBeenCalledTimes(1);
  expect(mockAlarm).toHaveBeenCalledWith(
    expect.objectContaining({
      db: tx,
      context: expect.objectContaining({ paymentIds: ["pay-1", "pay-2"] }),
    }),
  );
});
