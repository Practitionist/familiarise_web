/**
 * @jest-environment node
 */

/**
 * The request-expiring arm stages its bells through a transaction, so an
 * outbox write failure propagates to the arm instead of reaching Sentry once
 * per request; the arm reports the failures once per run.
 */
const mockCapture = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCapture(...a),
  captureMessage: jest.fn(),
  metrics: { count: jest.fn() },
}));
const HOUR = 60 * 60 * 1000;
const expiringRow = (id: string) => ({
  id,
  requestedAt: new Date(Date.now() - 43 * HOUR),
  requestedBy: { user: { name: "Olivia" } },
  consultationPlan: {
    title: "Mentorship",
    consultantProfile: { id: `cp_${id}`, user: { id: `u_${id}` } },
  },
  appointment: { organizationId: null },
});
jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(async ({ where }: { where: unknown }) =>
        JSON.stringify(where).includes('"requestedAt":{"gte"')
          ? [expiringRow("c1"), expiringRow("c2")]
          : [],
      ),
      findFirst: jest.fn(async () => null),
      updateMany: jest.fn(),
    },
    subscription: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      updateMany: jest.fn(),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    appointment: { findMany: jest.fn(async () => []) },
    user: {
      findMany: jest.fn(async () => [
        { id: "u_c1", erasedAt: null, notificationPreferences: null },
        { id: "u_c2", erasedAt: null, notificationPreferences: null },
      ]),
    },
    membership: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
    notificationOutbox: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => {
        throw new Error("outbox insert timed out");
      }),
    },
    failedEmail: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/booking/expiry-notices", () => ({
  UNANSWERED_REQUEST_REASON: "unanswered",
  notifyConsulteeRequestExpired: jest.fn(),
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({ trigger: jest.fn(), triggerBulk: jest.fn() }),
}));
jest.mock("../../lib/email", () => ({
  ...jest.requireActual("../../lib/email"),
  stageRequestExpiringEmail: jest.fn(async () => ({
    staged: [{}],
    renderFailures: 0,
  })),
}));

import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";

it("a bell write failure is reported once per run, never per request", async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});

  const result = await expireStaleRequests();

  expect(mockCapture).not.toHaveBeenCalled();
  expect(result.errors.filter((e) => e.includes("bell"))).toEqual([
    "2 request-expiring bell(s) failed to stage; retried next run",
  ]);
});
