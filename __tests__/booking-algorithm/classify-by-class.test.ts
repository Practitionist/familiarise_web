/**
 * The allocator classifies a failure by its error class (the stable code each
 * lock error carries), never by message text: a locking-service outage is a
 * 503 fault that reaches Sentry as a warning, contention is a 409 answer, and
 * an error whose message merely mentions a "lock" is not contention.
 */

import "./setup";

// appointmentlock pulls @upstash/redis (ESM-only uncrypto); only its error
// classes are under test.
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: (fn: () => unknown) => fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
}));
const mockReportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));
const mockAutoAllocate = jest.fn();
jest.mock("../../lib/booking/allocation/modes/auto", () => ({
  autoAllocate: (...args: unknown[]) => mockAutoAllocate(...args),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointment: { findFirst: jest.fn().mockResolvedValue(null) } },
}));

import { allocate } from "@/lib/booking/allocation";
import { classifyError } from "@/lib/booking/allocation/classify";
import {
  AppointmentBusyError,
  AutoAllocateBusyError,
  BookingLockUnavailableError,
  ConsulteeBookingBusyError,
  LockContentionError,
} from "@/utils/appointmentlock";
import { SearchTimeoutError } from "@/utils/scheduling-engine/errors";

describe("classifyError — by class, not substring", () => {
  it("maps a locking-service outage to 503 BOOKING_LOCK_UNAVAILABLE", () => {
    expect(
      classifyError(new BookingLockUnavailableError("auto-allocate")),
    ).toEqual({ errorCode: "BOOKING_LOCK_UNAVAILABLE", httpStatus: 503 });
  });

  it.each([
    ["auto-allocate busy", new AutoAllocateBusyError()],
    ["consultee busy", new ConsulteeBookingBusyError()],
    ["appointment busy", new AppointmentBusyError("appt-1")],
    ["raw contention", new LockContentionError("slot-booking:x", 3)],
  ])("maps %s to 409 LOCK_CONTENTION", (_label, error) => {
    expect(classifyError(error)).toEqual({
      errorCode: "LOCK_CONTENTION",
      httpStatus: 409,
    });
  });

  it("never reads contention from message text", () => {
    expect(
      classifyError(new TypeError("Cannot read properties of blockStart")),
    ).toEqual({ errorCode: "UNKNOWN_ERROR", httpStatus: 500 });
    expect(classifyError(new Error("Lock contention: in progress"))).toEqual({
      errorCode: "UNKNOWN_ERROR",
      httpStatus: 500,
    });
  });

  it("maps a truncated search to 503 SEARCH_TIMEOUT", () => {
    expect(classifyError(new SearchTimeoutError())).toEqual({
      errorCode: "SEARCH_TIMEOUT",
      httpStatus: 503,
    });
  });
});

describe("allocate() — outage reporting and copy", () => {
  beforeEach(() => {
    mockReportSentryError.mockReset();
    mockAutoAllocate.mockReset();
  });

  it("answers a Redis outage with 503, plain retry copy and a Sentry warning", async () => {
    mockAutoAllocate.mockRejectedValue(
      new BookingLockUnavailableError("auto-allocate"),
    );
    const result = await allocate({
      eventType: "consultation",
      eventId: "c-1",
      mode: "auto",
    });
    expect(result).toMatchObject({
      success: false,
      errorCode: "BOOKING_LOCK_UNAVAILABLE",
      httpStatus: 503,
    });
    expect(result.error).not.toMatch(/auto-allocate|lock/i);
    expect(mockReportSentryError).toHaveBeenCalledWith(
      expect.any(BookingLockUnavailableError),
      expect.objectContaining({ expected: false, level: "warning" }),
    );
  });

  it("never tells the expert about 'your account' when the client's key is busy", async () => {
    mockAutoAllocate.mockRejectedValue(new ConsulteeBookingBusyError());
    const result = await allocate({
      eventType: "consultation",
      eventId: "c-1",
      mode: "auto",
    });
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("LOCK_CONTENTION");
    expect(result.error).not.toMatch(/your account/i);
    expect(mockReportSentryError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expected: true }),
    );
  });
});
