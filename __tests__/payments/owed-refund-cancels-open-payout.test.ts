/**
 * @jest-environment node
 */

// Invariant: stamping an owed-refund marker cancels every PENDING or APPROVED
// payout that batched one of the payment's earnings and returns that payout's
// earnings to READY; the next batch pays the rest and leaves the owed one out.
// A PROCESSING payout is left alone.

import {
  payoutsTable,
  prismaStub,
  resetRaceWorld,
  seedEarning,
  state,
} from "../fixtures/money-race-world";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual<typeof import("../fixtures/money-race-world")>(
    "../fixtures/money-race-world",
  ).prismaStub,
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
// The clawback recovery reads and writes the ledger, which this suite does not model.
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  outstandingClawbackPaise: jest.fn().mockResolvedValue(0),
  recoverClawbackOnPayout: jest.fn().mockResolvedValue(0),
  releaseClawbackRecovery: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));

import {
  stampRefundOwed,
  stampRefundsOwed,
  type RefundOwedMarker,
} from "../../lib/payments/operations/refund-owed";
import { createPayoutBatch } from "../../lib/payments/payouts/payout-service";
import type { Tx } from "../../lib/prisma";

const marker = (paymentId: string): RefundOwedMarker => ({
  paymentId,
  amountPaise: 150_000,
  key: `cancel:appt:${paymentId}`,
  reason: "cancellation",
});

/** The world's transaction client, with the roster stamp's one raw statement modelled. */
const tx = {
  ...prismaStub,
  $executeRaw: jest.fn(async () => {
    let stamped = 0;
    for (const p of state.payments) {
      if (p.id !== "pay-1" || p.refundOwedKey) continue;
      p.refundOwedKey = marker("pay-1").key;
      stamped += 1;
    }
    return stamped;
  }),
} as unknown as Tx;

/** Two READY earnings of one expert on two payments, batched into one open payout. */
async function batchTwoEarnings() {
  seedEarning();
  seedEarning({ paymentId: "pay-2" });
  const batch = await createPayoutBatch();
  expect(batch.minted).toBe(1);
  expect(state.payouts[0]).toMatchObject({ id: "po-1", amount: 800_000 });
  expect(state.earnings.map((e) => e.status)).toEqual(["BATCHED", "BATCHED"]);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRaceWorld();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

it.each([
  ["a door's stamp", () => stampRefundOwed(tx, marker("pay-1"))],
  ["a roster stamp", () => stampRefundsOwed(tx, [marker("pay-1")])],
])(
  "%s cancels the open payout, and the next batch pays the other earning only",
  async (_label, stamp) => {
    await batchTwoEarnings();

    await stamp();

    expect(state.payments[0].refundOwedKey).toBe(marker("pay-1").key);
    expect(payoutsTable.updateMany).toHaveBeenCalledWith({
      where: { id: "po-1", status: { in: ["PENDING", "APPROVED"] } },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(state.payouts[0].status).toBe("CANCELLED");
    for (const earning of state.earnings) {
      expect(earning).toMatchObject({ status: "READY", payoutId: null });
    }

    const next = await createPayoutBatch();

    expect(next.minted).toBe(1);
    expect(state.payouts[1]).toMatchObject({ id: "po-2", amount: 400_000 });
    expect(state.earnings[0]).toMatchObject({
      status: "READY",
      payoutId: null,
    });
    expect(state.earnings[1]).toMatchObject({
      status: "BATCHED",
      payoutId: "po-2",
    });
  },
);

it("a payout already being sent is left alone", async () => {
  await batchTwoEarnings();
  state.payouts[0].status = "PROCESSING";

  await stampRefundOwed(tx, marker("pay-1"));

  expect(state.payouts[0].status).toBe("PROCESSING");
  expect(state.earnings.map((e) => e.status)).toEqual(["BATCHED", "BATCHED"]);
});
