/**
 * @jest-environment node
 */

/**
 * An operator reads a held-marker refusal with the payment, the refund holding
 * it and the next step for their own door; a refund still being sent is waited
 * for, never settled by hand while it is in flight.
 */

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  findDedupedRefund: jest.fn(async () => null),
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));

import { Refusal } from "@/lib/errors/refusal";
import { opsHeldMarkerMessage } from "@/lib/payments/operations/refund-owed";

const refusal = (code: string, subject: string) =>
  new Refusal({
    code,
    userMessage: "host copy",
    context: { paymentId: "pay-1", heldKey: "occ:o-1:pay:pay-1", subject },
  });

it("a stuck refund on a class seat: settle it from Needs human, then cancel the class again", () => {
  expect(opsHeldMarkerMessage(refusal("REFUND_NEEDS_SUPPORT", "class"))).toBe(
    "Seat payment pay-1 has a refund still owed from another action (occ:o-1:pay:pay-1); settle it from Refunds → Needs human, then cancel the class again.",
  );
});

it("a refund still being sent: wait for it, then retry the operator's own door", () => {
  expect(
    opsHeldMarkerMessage(
      refusal("REFUND_IN_PROGRESS", "webinar"),
      "run this again",
    ),
  ).toBe(
    "Seat payment pay-1 has a refund from another action (occ:o-1:pay:pay-1) still being sent; wait for it to finish, then run this again. If it fails, settle it by hand from Refunds → Needs human.",
  );
});

it("a 1:1 booking names the payment, not a seat", () => {
  expect(opsHeldMarkerMessage(refusal("REFUND_NEEDS_SUPPORT", "booking"))).toBe(
    "Payment pay-1 has a refund still owed from another action (occ:o-1:pay:pay-1); settle it from Refunds → Needs human, then cancel this booking again.",
  );
});

it("any other refusal keeps its own copy", () => {
  expect(
    opsHeldMarkerMessage(refusal("EXIT_NOT_AVAILABLE", "class")),
  ).toBeNull();
});
