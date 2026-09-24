/**
 * @jest-environment node
 */

// R-5 — an unknown provider status keeps the payout as it is; it used to fall
// through to PENDING and could reopen a row the gateway had already settled.
const mockTransaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findFirst: jest.fn(async () => ({ id: "po_1", earnings: [] })),
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));
const recordSystemEvent = jest.fn(async (_event: unknown) => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (event: unknown) => recordSystemEvent(event),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutFailed: jest.fn(),
  notifyPayoutProcessed: jest.fn(),
}));

import { handlePayoutWebhook } from "../../lib/payments/payouts/payout-service";

it("writes no status for a status it does not know", async () => {
  await handlePayoutWebhook(
    "RAZORPAY",
    "pout_1",
    "on_hold" as unknown as "PENDING",
  );
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(recordSystemEvent).toHaveBeenCalledWith(
    expect.objectContaining({ category: "PAYOUT", severity: "WARN" }),
  );
});
