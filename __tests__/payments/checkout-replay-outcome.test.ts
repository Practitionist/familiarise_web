/**
 * @jest-environment node
 */

/**
 * A same-key replay of a SUCCEEDED checkout answers what became of the money
 * and the booking, read from the payment's own rows: booked, refunded, being
 * refunded, or needs support. Only "booked" is a success.
 */

const mockPaymentFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a) },
  },
}));

import { replayByIdempotencyKey } from "../../lib/payments/operations/checkout-replay";
import { getErrorToast } from "../../lib/errors/mapping/payment-error-toast-map";

/** The row the replay's `select` returns for a paid checkout with a live booking. */
function succeeded(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    requestFingerprint: "fp",
    paymentIntent: "order_x",
    paymentStatus: "SUCCEEDED",
    paymentGateway: "RAZORPAY",
    amount: 50_000,
    currency: "INR",
    appointmentId: "appt-1",
    isMockPayment: false,
    expiresAt: null,
    description: null,
    refundOwedKey: null,
    refunds: [],
    appointment: { deletedAt: null, participants: [{ id: "seat-1" }] },
    ...over,
  };
}

async function replay(row: Record<string, unknown>) {
  mockPaymentFindFirst.mockResolvedValue(row);
  const res = await replayByIdempotencyKey("user-1", "ck_abc12345", "fp");
  if (!(res instanceof Response)) throw new Error("expected a response");
  return { status: res.status, body: await res.json() };
}

const noBooking = { appointmentId: null, appointment: null };
const endedBooking = { appointment: { deletedAt: null, participants: [] } };

it("a paid checkout with a live booking is booked, and still skips payment", async () => {
  const { status, body } = await replay(succeeded());

  expect(status).toBe(200);
  expect(body).toMatchObject({
    success: true,
    skipPayment: true,
    outcome: "booked",
    appointmentId: "appt-1",
  });
  // The buyer's own seat decides "live": the read is scoped to the caller.
  expect(mockPaymentFindFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      select: expect.objectContaining({
        appointment: {
          select: {
            deletedAt: true,
            participants: expect.objectContaining({
              where: expect.objectContaining({ userId: "user-1" }),
            }),
          },
        },
      }),
    }),
  );
});

it.each([
  [
    "a capture that funded no booking and is queued for its automatic refund",
    {
      ...noBooking,
      description:
        "Auto-refund pending: capture landed after the seat was released. Booking NOT confirmed.",
    },
    "being_refunded",
    "CHECKOUT_REFUND_IN_PROGRESS",
  ],
  [
    "a cancelled booking whose refund is owed",
    { ...endedBooking, refundOwedKey: "cancel:appt-1" },
    "being_refunded",
    "CHECKOUT_REFUND_IN_PROGRESS",
  ],
  [
    "a cancelled booking whose refund is still at the gateway",
    { ...endedBooking, refunds: [{ status: "PENDING", amountPaise: 50_000 }] },
    "being_refunded",
    "CHECKOUT_REFUND_IN_PROGRESS",
  ],
  [
    "a capture whose automatic refund has settled",
    {
      ...noBooking,
      description:
        "Auto-refunded: capture amount 49000p ≠ expected 50000p. Booking NOT confirmed.",
    },
    "refunded",
    "CHECKOUT_REFUNDED",
  ],
  [
    "a payment refunded in full, even while a seat row still reads live",
    { refunds: [{ status: "SUCCEEDED", amountPaise: 50_000 }] },
    "refunded",
    "CHECKOUT_REFUNDED",
  ],
  [
    "a capture whose automatic refund gave up",
    {
      ...noBooking,
      description:
        "Auto-refund stuck: capture landed after the seat was released. Booking NOT confirmed.",
    },
    "needs_support",
    "CHECKOUT_NEEDS_SUPPORT",
  ],
  [
    "a capture parked for manual recovery",
    {
      ...noBooking,
      description:
        "REQUIRES_MANUAL_RECOVERY: Metadata validation failed. Customer charged but appointment NOT created.",
    },
    "needs_support",
    "CHECKOUT_NEEDS_SUPPORT",
  ],
  [
    "a paid checkout with no booking and nothing on its way back",
    noBooking,
    "needs_support",
    "CHECKOUT_NEEDS_SUPPORT",
  ],
  [
    "a free seat its holder has left",
    { amount: 0, ...endedBooking },
    "ended",
    "CHECKOUT_BOOKING_ENDED",
  ],
  [
    "a free booking that was removed",
    { amount: 0, ...noBooking },
    "ended",
    "CHECKOUT_BOOKING_ENDED",
  ],
])(
  "%s is answered 409 with its outcome",
  async (_label, over, outcome, errorType) => {
    const { status, body } = await replay(succeeded(over));

    expect(status).toBe(409);
    expect(body).toMatchObject({ outcome, errorType });
    expect(body.success).toBeUndefined();
    expect(body.skipPayment).toBeUndefined();
    // The client's toast: its own title for the outcome, the server's sentence as the body.
    const toast = getErrorToast(body.errorType, body.error, body.code);
    expect(toast.title).not.toBe(getErrorToast("UNKNOWN_ERROR").title);
    expect(toast.description).toBe(body.error);
  },
);

it("a live booking with a partial refund is still booked", async () => {
  const { status, body } = await replay(
    succeeded({ refunds: [{ status: "SUCCEEDED", amountPaise: 10_000 }] }),
  );

  expect(status).toBe(200);
  expect(body.outcome).toBe("booked");
});

it("says a charge was taken only when one was", async () => {
  const charged = await replay(succeeded(noBooking));
  const free = await replay(succeeded({ amount: 0, ...endedBooking }));

  expect(charged.body.error).toMatch(/You were charged/);
  expect(free.body.error).toBe(
    "This booking has ended and nothing was charged. Refresh the page to book again.",
  );
});

it("a free seat that is still live is booked", async () => {
  const { status, body } = await replay(succeeded({ amount: 0 }));

  expect(status).toBe(200);
  expect(body).toMatchObject({ outcome: "booked", skipPayment: true });
});
