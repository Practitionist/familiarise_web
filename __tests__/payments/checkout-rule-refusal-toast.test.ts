/**
 * @jest-environment node
 */

// Invariant: a checkout rule refusal is titled by its own copy, never the
// gateway's "Payment Failed … contact your bank" fallback.

import { createRazorpayCheckoutHandlers } from "@/app/checkout/plans/utils";
import { PLAN_CLIENTS_FULL_MESSAGE } from "@/schemas/plan-clients";

const toasts: { title?: unknown; description?: unknown }[] = [];
const { onPaymentError } = createRazorpayCheckoutHandlers(((t: object) => {
  toasts.push(t);
  return { id: "t", dismiss: () => {}, update: () => {} };
}) as never);

beforeEach(() => {
  toasts.length = 0;
});

it("a full expert gets its own fully-booked copy, with no raw code", () => {
  onPaymentError({
    description: "This expert's mentorship plans are fully booked right now.",
    code: "PLAN_CLIENTS_FULL",
    errorType: "PLAN_CLIENTS_FULL_ERROR",
  });
  const [toast] = toasts;
  expect(toast.title).toBe("This expert is fully booked");
  // The same sentence the checkout banner and the server refusal use.
  expect(toast.description).toBe(PLAN_CLIENTS_FULL_MESSAGE);
  expect(JSON.stringify(toast)).not.toMatch(/contact your bank|PLAN_CLIENTS/);
});

it.each([
  ["NOT_PLACEABLE_ERROR", undefined, "No free time in the first week"],
  [
    "BOOKING_RULE_ERROR",
    "NOT_ACCEPTING_BOOKINGS",
    "Not available for this booking",
  ],
  [
    "REQUEST_APPROVAL_REQUIRED_ERROR",
    "REQUEST_APPROVAL_REQUIRED",
    "This expert reviews requests first",
  ],
  [
    "SUBSCRIPTION_ALREADY_ACTIVE_ERROR",
    undefined,
    "You already have this plan",
  ],
])("the %s refusal keeps its typed title", (errorType, code, title) => {
  onPaymentError({
    description: "The thrown sentence.",
    code: code ?? errorType,
    errorType,
  });
  expect(toasts[0].title).toBe(title);
  expect(String(toasts[0].description)).not.toMatch(/contact your bank/);
});

it("an untyped gateway error never doubles its full stop", () => {
  onPaymentError({ description: "Card issuer unavailable." });
  expect(toasts[0].description).toBe(
    "Card issuer unavailable. Please try again or contact your bank for assistance.",
  );
});
