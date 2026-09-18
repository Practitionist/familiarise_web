/**
 * AllocationService HTTP resilience.
 *
 * Edge 504s / HTML error pages under traffic spikes throw out of
 * `response.json()`. The client must still propagate the HTTP status so the
 * caller can take the 409/allocated-elsewhere branch (conflict refetch +
 * toast) instead of reporting a status-less network error.
 */

import "./setup";

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import { AllocationService } from "@/lib/scheduling/allocationService";

// Valid UUID shape per isEventIdFormat — passes the fail-closed guard so the
// test reaches the fetch path.
const EVENT_ID = "123e4567-e89b-12d3-a456-426614174000";

function mockFetch(response: unknown) {
  global.fetch = jest
    .fn()
    .mockResolvedValue(response) as unknown as typeof fetch;
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

describe("allocateSlots with malformed 2xx bodies (fail-closed)", () => {
  it("returns success:false with httpStatus when a 2xx body is not JSON", async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    const result = await AllocationService.allocateSlots(
      "consultation",
      EVENT_ID,
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(200);
  });

  it("returns success:false with httpStatus when a 2xx body has no data array", async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const result = await AllocationService.allocateSlots(
      "consultation",
      EVENT_ID,
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(200);
  });

  it("still reports success when a 2xx body carries a data array", async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "apt-1" }] }),
    });

    const result = await AllocationService.allocateSlots(
      "consultation",
      EVENT_ID,
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ id: "apt-1" }]);
  });
});

describe("allocateSlots with a non-UUID event id (fail-closed guard)", () => {
  it("refuses with friendly copy that never leaks the id or internals", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await AllocationService.allocateSlots(
      "consultation",
      "mock-ui-consult-01",
      [],
      { isAuto: true },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("VALIDATION_ERROR");
    expect(result.error).not.toContain("mock-ui-consult-01");
    expect(result.error).not.toMatch(/UUID|CUID|reseed/i);
    // Fail-closed before any network: no request is ever issued.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * #1703 QA-4 (FAMILIARISE_WEB-4J) — a read the caller aborted (the page
 * moved on) is not a fault: no Sentry event, and the same empty answer the
 * hook degrades to. The same TypeError WITHOUT an abort is offline, which
 * still reports, as expected rather than as an alert.
 */
describe("fetchEventSlots when the page moves on mid-read", () => {
  it("returns the quiet empty result without reporting", async () => {
    const { reportSentryError } = jest.requireMock(
      "../../lib/observability/report",
    ) as { reportSentryError: jest.Mock };
    reportSentryError.mockClear();
    const controller = new AbortController();
    global.fetch = jest.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new TypeError("Failed to fetch"));
    }) as unknown as typeof fetch;

    const result = await AllocationService.fetchEventSlots(
      "consultation",
      EVENT_ID,
      "consultant-1",
      undefined,
      controller.signal,
    );

    expect(result).toEqual({ data: [], weeklyConfirmedCallCounts: {} });
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("reports an un-aborted network failure as expected, then throws", async () => {
    const { reportSentryError } = jest.requireMock(
      "../../lib/observability/report",
    ) as { reportSentryError: jest.Mock };
    reportSentryError.mockClear();
    global.fetch = jest
      .fn()
      .mockRejectedValue(
        new TypeError("Failed to fetch"),
      ) as unknown as typeof fetch;

    await expect(
      AllocationService.fetchEventSlots("consultation", EVENT_ID, "c1"),
    ).rejects.toThrow("Failed to fetch");
    expect(reportSentryError).toHaveBeenCalledTimes(1);
    expect(reportSentryError.mock.calls[0][1]).toMatchObject({
      expected: true,
    });
  });

  it("still reports a real fault", async () => {
    const { reportSentryError } = jest.requireMock(
      "../../lib/observability/report",
    ) as { reportSentryError: jest.Mock };
    reportSentryError.mockClear();
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("boom")) as unknown as typeof fetch;

    await expect(
      AllocationService.fetchEventSlots("consultation", EVENT_ID, "c1"),
    ).rejects.toThrow("boom");
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });
});
