/**
 * @jest-environment node
 */

/**
 * Unified reversal engine dispatch (#776 §C / ARCH #4). Asserts the front door
 * routes each source kind correctly and that CLASS_MULTI fans a single logical
 * refund across child payments proportionally (the genuinely-new capability —
 * consolidated CLASS purchases have no single paymentId). The deep booking
 * cascade is mocked; it's tested in its own suite.
 */

import { applyReversal } from "@/lib/payments/operations/reversal-engine";
import { applyRefundCascade } from "../../lib/payments/operations/refund";

jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({
    legsReversed: 1,
    consultantEarningsReversed: 1,
    organizationEarningsReversed: 0,
    clawbackInitiated: false,
  }),
}));
// #1583 C-P1-09 — the clawback's ledger posting, rejectable per test.
const mockPostLedgerTxn = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const mockedCascade = applyRefundCascade as jest.MockedFunction<
  typeof applyRefundCascade
>;

beforeEach(() => mockedCascade.mockClear());

describe("applyReversal — BOOKING", () => {
  it("delegates to applyRefundCascade with the payment id", async () => {
    const tx = {} as never;
    const res = await applyReversal(tx, {
      source: { kind: "BOOKING", paymentId: "pay-1" },
      amountPaise: 5000,
      reason: "test",
      refundId: "ref-1",
    });
    expect(res.kind).toBe("BOOKING");
    expect(res.cascades).toHaveLength(1);
    expect(mockedCascade).toHaveBeenCalledTimes(1);
    expect(mockedCascade).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ paymentId: "pay-1", amountPaise: 5000 }),
    );
  });
});

describe("applyReversal — CLASS_MULTI", () => {
  function mockTx(
    payments: Array<{
      id: string;
      amount: number;
      // #1583 C-P0-03 — prior money on the seat, which the clamp nets out.
      refunds?: Array<{ amountPaise: number; status: string }>;
    }>,
  ) {
    return {
      payment: {
        findMany: jest.fn().mockResolvedValue(
          payments.map((p) => ({
            id: p.id,
            amount: p.amount,
            currency: "INR",
            paymentGateway: "RAZORPAY",
            // #781 §C — the reversal must copy these onto each child refund.
            displayCurrencyAtCheckout: "USD",
            exchangeRateAtCheckout: 83,
            refunds: p.refunds ?? [],
            disputes: [],
          })),
        ),
      },
      refund: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: `cn-${data.paymentId}`,
        })),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }

  it("fans the refund across children proportionally; last absorbs remainder", async () => {
    // Two equal payments, total 100, refund 51 → 25 + 26 (last absorbs +1).
    const tx = mockTx([
      { id: "p1", amount: 50 },
      { id: "p2", amount: 50 },
    ]);
    const res = await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
      amountPaise: 51,
      reason: "class refund",
      refundId: "parent-ref",
    });

    expect(res.kind).toBe("CLASS_MULTI");
    expect(mockedCascade).toHaveBeenCalledTimes(2);
    const shares = mockedCascade.mock.calls.map((c) => c[1].amountPaise).sort();
    expect(shares).toEqual([25, 26]);
    // Each child got its own Refund row created + marked SUCCEEDED.
    expect(tx.refund.create).toHaveBeenCalledTimes(2);
    expect(tx.refund.update).toHaveBeenCalledTimes(2);
    // #781 §C — each child refund carries the parent payment's FX snapshot.
    expect(tx.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          displayCurrency: "USD",
          exchangeRateAtRefund: 83,
        }),
      }),
    );
  });

  it("never lets a child's share exceed its own amount (remainder distribution)", async () => {
    // Pathological: three ₹0.01 children, refund 2 paise. A naive
    // "last absorbs remainder" would push the last child to 2 > its amount 1
    // and crash applyRefundCascade's refundable guard. The distribution caps
    // each child at its own amount.
    const tx = mockTx([
      { id: "p1", amount: 1 },
      { id: "p2", amount: 1 },
      { id: "p3", amount: 1 },
    ]);
    await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2", "p3"] },
      amountPaise: 2,
      reason: "r",
      refundId: "ref",
    });
    const shares = mockedCascade.mock.calls.map((c) => c[1].amountPaise);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(2);
    expect(Math.max(...shares)).toBeLessThanOrEqual(1);
    // Third child's share nets to 0 → skipped.
    expect(mockedCascade).toHaveBeenCalledTimes(2);
  });

  it("throws fast on an over-refund (amount > class total) without touching children", async () => {
    const tx = mockTx([
      { id: "p1", amount: 100 },
      { id: "p2", amount: 100 },
    ]);
    await expect(
      applyReversal(tx as never, {
        source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
        amountPaise: 250,
        reason: "r",
        refundId: "ref",
      }),
    ).rejects.toThrow(/exceeds the batch's refundable balance/);
    expect(mockedCascade).not.toHaveBeenCalled();
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it("skips zero-share children", async () => {
    const tx = mockTx([
      { id: "p1", amount: 100 },
      { id: "p2", amount: 0 },
    ]);
    await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
      amountPaise: 100,
      reason: "r",
      refundId: "ref",
    });
    // p2 (amount 0) gets share 0 → no cascade for it.
    expect(mockedCascade).toHaveBeenCalledTimes(1);
    expect(mockedCascade.mock.calls[0][1].amountPaise).toBe(100);
  });

  // #1583 C-P0-03 / C-P0-04 — the share base and the headroom cap are the
  // seat's REFUNDABLE balance, so a seat already refunded on its own gets no
  // second Refund row and no second cascade.
  it("clamps each child to its refundable balance and skips a fully-refunded seat", async () => {
    const tx = mockTx([
      {
        id: "p1",
        amount: 100,
        refunds: [{ amountPaise: 100, status: "SUCCEEDED" }],
      },
      { id: "p2", amount: 100 },
    ]);
    await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
      amountPaise: 100,
      reason: "r",
      refundId: "ref",
    });
    expect(tx.refund.create).toHaveBeenCalledTimes(1);
    expect(tx.refund.create.mock.calls[0][0].data).toMatchObject({
      paymentId: "p2",
      amountPaise: 100,
    });
    expect(mockedCascade).toHaveBeenCalledTimes(1);
    expect(mockedCascade.mock.calls[0][1]).toMatchObject({
      paymentId: "p2",
      amountPaise: 100,
    });
  });

  it("is a no-op when every seat is already refunded", async () => {
    const tx = mockTx([
      {
        id: "p1",
        amount: 100,
        refunds: [{ amountPaise: 100, status: "SUCCEEDED" }],
      },
    ]);
    const res = await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1"] },
      amountPaise: 0,
      reason: "r",
      refundId: "ref",
    });
    expect(res.childRefundIds).toEqual([]);
    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(mockedCascade).not.toHaveBeenCalled();
  });
});

// #1583 C-P1-09 — the clawback's counter-post was reported and swallowed, so a
// payout could be stamped clawed-back with no journal behind it. The failure
// now propagates and the enclosing refund transaction rolls back with it.
describe("applyReversal — PAYOUT_CLAWBACK", () => {
  it("propagates a rejected ledger posting instead of committing an unbalanced journal", async () => {
    const tx = {
      organizationPayout: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "payout-1", clawbackInitiatedAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    mockPostLedgerTxn.mockRejectedValueOnce(new Error("journal unbalanced"));

    await expect(
      applyReversal(tx as never, {
        source: {
          kind: "PAYOUT_CLAWBACK",
          orgPayoutId: "payout-1",
          organizationId: "org-1",
        },
        amountPaise: 50_000,
        reason: "dispute lost",
        refundId: "refund-1",
      }),
    ).rejects.toThrow("journal unbalanced");
  });
});
