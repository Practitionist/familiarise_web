/**
 * Setup file for booking-algorithm tests.
 * Polyfills TextEncoder/TextDecoder needed by Prisma client in jsdom.
 */

import { TextEncoder, TextDecoder } from "util";

if (typeof global.TextEncoder === "undefined") {
  (global as any).TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  (global as any).TextDecoder = TextDecoder;
}

// PR 2c — SchedulingService now imports lib/novu (allocation-time
// notification). @novu/node pulls undici's Request at import time, which the
// Jest environment lacks; every suite that loads the allocator would fail to
// even parse. The notification itself is fire-and-forget and asserted via
// these mocks where relevant.
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  // #1697 item 5 — staged in the allocation tx; the result arrays must be
  // iterable so the stage helper can collect `.staged` rows.
  notifyAppointmentBooked: jest.fn().mockResolvedValue([]),
  notifyAppointmentPartiallyScheduled: jest.fn().mockResolvedValue([]),
  attemptTrigger: jest.fn(),
  notifyAppointmentCancelled: jest.fn(),
  notifyAppointmentRescheduled: jest.fn(),
  notifyAppointmentCompleted: jest.fn(),
  notifyAppointmentReminder: jest.fn(),
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyNewBookingRequest: jest.fn(),
}));

// #1697 item 5 — the allocator attempts its staged notices through
// `scheduleAfter`, whose `next/server` import needs a Request global the jsdom
// suites lack. The fallback shape is the same floating promise it degrades to.
jest.mock("../../lib/api/after-safe", () => ({
  __esModule: true,
  scheduleAfter: (task: () => Promise<unknown> | unknown) => {
    void Promise.resolve()
      .then(task)
      .catch(() => undefined);
  },
}));
