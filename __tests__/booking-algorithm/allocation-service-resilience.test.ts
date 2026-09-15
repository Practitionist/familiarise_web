/**
 * AllocationService HTTP resilience.
 *
 * Edge 504s / HTML error pages under traffic spikes throw out of
 * `response.json()`. The client must still propagate the HTTP status so the
 * caller can take the 409/allocated-elsewhere branch (conflict refetch +
 * toast) instead of reporting a status-less network error.
 */

import "./setup";

import { AllocationService } from "@/lib/scheduling/allocationService";

// Valid UUID shape per isEventIdFormat — passes the fail-closed guard so the
// test reaches the fetch path.
const EVENT_ID = "123e4567-e89b-12d3-a456-426614174000";

function mockFetch(response: unknown) {
  global.fetch = jest.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("allocateSlots with non-JSON error bodies", () => {
  it("preserves httpStatus 409 when the error body is not JSON", async () => {
    mockFetch({
      ok: false,
      status: 409,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    const result = await AllocationService.allocateSlots(
      "consultation",
      EVENT_ID,
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
  });

  it("preserves httpStatus 503 when the error body is empty", async () => {
    mockFetch({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    const result = await AllocationService.allocateSlots(
      "subscription",
      EVENT_ID,
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(503);
  });

  it("still surfaces structured fields on a normal JSON refusal", async () => {
    mockFetch({
      ok: false,
      status: 409,
      json: async () => ({
        error: "Slot already booked",
        errorCode: "CONFLICT",
        placeableSessions: 2,
        requiredSessions: 4,
      }),
    });

    const result = await AllocationService.allocateSlots(
      "subscription",
      EVENT_ID,
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.error).toBe("Slot already booked");
    expect(result.errorCode).toBe("CONFLICT");
    expect(result.placeableSessions).toBe(2);
    expect(result.requiredSessions).toBe(4);
  });
});
