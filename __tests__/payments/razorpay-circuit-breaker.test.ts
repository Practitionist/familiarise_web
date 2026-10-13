/**
 * @jest-environment node
 */

import { shouldTripRazorpayCircuitBreaker } from "../../lib/payments/core/razorpay";

describe("shouldTripRazorpayCircuitBreaker (#697 INF-3)", () => {
  it("does NOT trip on 4xx client validation errors (400, 404, 422)", () => {
    expect(shouldTripRazorpayCircuitBreaker({ statusCode: 400 })).toBe(false);
    expect(shouldTripRazorpayCircuitBreaker({ status: 404 })).toBe(false);
    expect(
      shouldTripRazorpayCircuitBreaker({
        error: { statusCode: 422, description: "Invalid VPA" },
      }),
    ).toBe(false);
  });

  it("trips on 5xx gateway errors, 429 rate-limit errors, and network failures", () => {
    expect(shouldTripRazorpayCircuitBreaker({ statusCode: 500 })).toBe(true);
    expect(shouldTripRazorpayCircuitBreaker({ statusCode: 502 })).toBe(true);
    expect(shouldTripRazorpayCircuitBreaker({ statusCode: 503 })).toBe(true);
    expect(shouldTripRazorpayCircuitBreaker({ statusCode: 429 })).toBe(true);
    expect(
      shouldTripRazorpayCircuitBreaker(new Error("ECONNRESET socket hang up")),
    ).toBe(true);
  });
});
