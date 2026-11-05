/**
 * @jest-environment node
 */

/**
 * The maintenance freeze ends a booking even when another door's refund already
 * holds one of its payments. That payment is recorded and its earnings held for
 * a hand top-up; only the markers the freeze owns are queued for the retry sweep.
 */

const mockRecordSystemEvent = jest.fn(async () => undefined);
const mockPlaceEarningsHolds = jest.fn(async () => ["placed"]);

jest.mock("../../lib/enterprise/system-events", () => ({
  ...jest.requireActual("../../lib/enterprise/system-events"),
  recordSystemEvent: (...a: unknown[]) => mockRecordSystemEvent(...(a as [])),
}));
jest.mock("../../lib/payments/payouts/earnings-holds", () => ({
  ...jest.requireActual("../../lib/payments/payouts/earnings-holds"),
  placeEarningsHolds: (...a: unknown[]) => mockPlaceEarningsHolds(...(a as [])),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));

import { stampFreezeRefunds } from "@/actions/maintenance/freeze-appointments";
import type { Tx } from "@/lib/prisma";

const HELD_KEY = "occ:occ-1:pay:pay-held";

function txDouble(stamped: number) {
  return {
    $executeRaw: jest.fn(async () => stamped),
    payment: {
      findMany: jest.fn(async () => [
        { id: "pay-held", refundOwedKey: HELD_KEY, refundOwedPaise: 1_000 },
      ]),
      findUnique: jest.fn(async () => ({
        amount: 50_000,
        refunds: [],
        disputes: [],
      })),
    },
    systemEvent: { findFirst: jest.fn(async () => null) },
    consultantEarnings: { findMany: jest.fn(async () => [{ id: "ce-1" }]) },
    organizationEarnings: { findMany: jest.fn(async () => []) },
  } as unknown as Tx;
}

const payments = [
  { id: "pay-free", paymentStatus: "SUCCEEDED" as const, deletedAt: null },
  { id: "pay-held", paymentStatus: "SUCCEEDED" as const, deletedAt: null },
];

beforeEach(() => jest.clearAllMocks());

it("queues only the freeze's own markers and holds the payment another door's refund holds", async () => {
  const queued = await stampFreezeRefunds(txDouble(1), "apt-1", payments);
  expect(queued.map((m) => m.paymentId)).toEqual(["pay-free"]);
  expect(mockRecordSystemEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      correlationId: "owed-already-held:pay-held:freeze:apt-1:pay-held",
      strict: true,
      // A full-balance freeze owes what the holding ₹10 leaves of ₹500.
      context: expect.objectContaining({ owedPaise: 49_000 }),
    }),
  );
  expect(mockPlaceEarningsHolds).toHaveBeenCalledWith(
    expect.anything(),
    "consultant",
    ["ce-1"],
    expect.objectContaining({
      reason: "OPERATOR",
      sourceRef: "owed-already-held:pay-held:freeze:apt-1:pay-held",
    }),
  );
});

it("a freeze that owns every marker records nothing and holds nothing", async () => {
  const queued = await stampFreezeRefunds(txDouble(2), "apt-1", payments);
  expect(queued).toHaveLength(2);
  expect(mockRecordSystemEvent).not.toHaveBeenCalled();
  expect(mockPlaceEarningsHolds).not.toHaveBeenCalled();
});
