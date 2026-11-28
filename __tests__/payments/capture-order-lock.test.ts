/**
 * @jest-environment node
 */

/**
 * Doors confirming one capture take turns on the order: the capture
 * transaction's first statements bound its lock waits and take the order's
 * advisory lock, and a lock timeout is handed back to the door, not retried.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

const txExecuteRaw = jest.fn(async (..._a: unknown[]) => 1);
const txPaymentFindUnique = jest.fn();
const transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
  fn({
    $executeRaw: txExecuteRaw,
    payment: { findUnique: txPaymentFindUnique },
  }),
);
const pendingRow = {
  id: "pay_lock",
  paymentIntent: "order_lock",
  amount: 10_000,
  paymentStatus: "PENDING",
  gatewayPaymentId: null,
  userId: "u1",
  appointmentId: null,
  appointment: null,
  user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => unknown) => transaction(fn),
    payment: { findUnique: async () => pendingRow },
  },
}));

jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/email", () => ({}));
jest.mock("../../lib/novu", () => ({}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: jest.fn(),
}));

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";
import { isLockTimeout } from "../../lib/db/pg-errors";
import {
  expectCaptureLockFirst,
  rawCall,
} from "../fixtures/capture-order-lock";

const pgError = (code: string, message: string) =>
  Object.assign(new Error(message), {
    name: "DriverAdapterError",
    cause: { kind: "postgres", code, originalCode: code, message },
  });

beforeEach(() => {
  jest.clearAllMocks();
  txExecuteRaw.mockResolvedValue(1);
  txPaymentFindUnique.mockResolvedValue(pendingRow);
});

it("bounds its lock waits and takes the order's advisory lock before reading the payment", async () => {
  // No gateway amount: Phase 1 reads the payment and stays PENDING.
  await expect(handlePaymentSuccess("order_lock", {})).resolves.toBeNull();

  expectCaptureLockFirst(txExecuteRaw, "order_lock");
  expect(txExecuteRaw.mock.invocationCallOrder[1]).toBeLessThan(
    txPaymentFindUnique.mock.invocationCallOrder[0],
  );
});

it("hands a lock timeout back to the door without a serializable retry", async () => {
  const timeout = pgError("55P03", "canceling statement due to lock timeout");
  txExecuteRaw.mockResolvedValueOnce(1).mockRejectedValueOnce(timeout);

  const failure = await handlePaymentSuccess("order_lock", {}, 10_000).catch(
    (err: unknown) => err,
  );

  expect(failure).toBe(timeout);
  expect(isLockTimeout(failure)).toBe(true);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(txPaymentFindUnique).not.toHaveBeenCalled();

  // A write conflict on the same statement is still retried.
  txExecuteRaw
    .mockResolvedValueOnce(1)
    .mockRejectedValueOnce(pgError("40001", "could not serialize access"));
  transaction.mockClear();
  txExecuteRaw.mockClear();
  await handlePaymentSuccess("order_lock", {});
  expect(transaction).toHaveBeenCalledTimes(2);
  // The replay opens with the same lock timeout and order lock as the first attempt.
  const statements = txExecuteRaw.mock.calls.map(rawCall);
  expect(statements).toHaveLength(4);
  expect(statements.slice(2)).toEqual(statements.slice(0, 2));
  expect(statements[2].values).toEqual(["4000"]);
  expect(statements[3].values).toEqual(["payment-capture:order_lock"]);
});
