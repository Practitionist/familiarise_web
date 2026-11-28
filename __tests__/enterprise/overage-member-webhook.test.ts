/**
 * @jest-environment node
 */

/**
 * #775/#782 — CHARGE_MEMBER side-charge capture webhook.
 *
 * Pins the settlement contract the OVERAGE_SETTLEMENT_MISMATCH reconcile
 * invariant asserts: a capture flips the side-Payment → SUCCEEDED, moves the
 * event PENDING/FAILED → CHARGED, and ONLY THEN posts the org-relief journal
 * (`overage:<sidePaymentId>`: Dr GATEWAY_CLEARING / Cr DISCOUNT(base) + PLATFORM_FEE(surcharge) + GST_PAYABLE).
 * If the event can't legally reach CHARGED (REVERSED mid-flight), no org
 * credit is posted: the cash is parked and auto-refunded after commit.
 */

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    paymentLeg: { updateMany: jest.fn() },
    overageEvent: {
      findFirst: jest.fn().mockResolvedValue({ basePaise: 100_000 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    systemEvent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  return {
    __esModule: true,
    default: {
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      __tx: tx,
    },
  };
});
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoiceBestEffort: jest.fn().mockResolvedValue({}),
}));
const mockRefund = jest.fn().mockResolvedValue({ status: "SUCCEEDED" });
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefund(...a),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  restoreOverageBaseCarve: jest.fn().mockResolvedValue("restored"),
  recarveOverageBase: jest.fn().mockResolvedValue("recarved"),
  releaseOverageHeldParentEarnings: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});

import prisma from "../../lib/prisma";
import { postLedgerTxn } from "../../lib/payments/ledger/post";
import { transitionOverage } from "../../lib/payments/billing/overage-transitions";
import { recordSystemError } from "../../lib/enterprise/system-events";
import { handleOverageMemberSuccess } from "../../lib/payments/webhooks/overage-handlers";

const tx = (
  prisma as unknown as {
    __tx: {
      payment: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
        count: jest.Mock;
      };
      paymentLeg: { updateMany: jest.Mock };
      overageEvent: { findMany: jest.Mock };
    };
  }
).__tx;
const mockTransition = transitionOverage as jest.Mock;
const mockPost = postLedgerTxn as jest.Mock;
const mockSystemError = recordSystemError as jest.Mock;

const side = {
  id: "side1",
  amount: 129_500,
  taxAmount: 4_500,
  organizationId: "org1",
  paymentStatus: "PENDING",
  parentPaymentId: "parent1",
};

beforeEach(() => {
  jest.clearAllMocks();
  tx.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe("handleOverageMemberSuccess", () => {
  it("capture: SUCCEEDED + CHARGED, then Dr GATEWAY_CLEARING / Cr DISCOUNT + PLATFORM_FEE + GST_PAYABLE", async () => {
    tx.payment.findUnique.mockResolvedValue(side);
    mockTransition.mockResolvedValue(1);

    await handleOverageMemberSuccess("order_abc", 129_500);

    // #1846 SM-B2 — the status just read rides the WHERE.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "side1", paymentStatus: "PENDING" },
      data: { paymentStatus: "SUCCEEDED" },
    });
    // the CARD leg minted with the side charge gets the gateway order id
    expect(tx.paymentLeg.updateMany).toHaveBeenCalledWith({
      where: { paymentId: "side1", source: "CARD" },
      data: { sourceRef: "order_abc" },
    });
    // #812 — two-step CAS: the still-carved edge is tried first.
    expect(mockTransition).toHaveBeenCalledWith(
      tx,
      { paymentId: "side1" },
      "CHARGED",
      { settledAt: expect.any(Date) },
      { fromIn: ["PENDING", "ACCRUED"] },
    );
    // the journal the CHARGE_MEMBER reconcile invariant joins on
    expect(mockPost).toHaveBeenCalledWith(tx, {
      idempotencyKey: "overage:side1",
      kind: "OVERAGE_MEMBER",
      paymentId: "side1",
      postings: [
        {
          account: { kind: "GATEWAY_CLEARING" },
          direction: "DEBIT",
          amountPaise: 129_500,
        },
        {
          account: { kind: "DISCOUNT" },
          direction: "CREDIT",
          amountPaise: 100_000,
        },
        {
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise: 25_000,
        },
        {
          account: { kind: "GST_PAYABLE" },
          direction: "CREDIT",
          amountPaise: 4_500,
        },
      ],
    });
    expect(mockSystemError).not.toHaveBeenCalled();
  });

  it("webhook redelivery (already SUCCEEDED) is a no-op", async () => {
    tx.payment.findUnique.mockResolvedValue({
      ...side,
      paymentStatus: "SUCCEEDED",
    });

    await handleOverageMemberSuccess("order_abc", 129_500);

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("capture racing a reversal (event REVERSED): no org credit, cash parked and auto-refunded", async () => {
    tx.payment.findUnique.mockResolvedValue(side);
    mockTransition.mockResolvedValue(0); // REVERSED not in CHARGED's allowed-from

    await handleOverageMemberSuccess("order_abc", 129_500);

    const keys = mockPost.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys).toEqual(["unapplied:side1"]);
    expect(mockSystemError).not.toHaveBeenCalled();
    expect(mockRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "side1",
        amountPaise: 129_500,
        dedupeKey: "overage-mismatch:side1",
      }),
    );
  });

  it("failure commits FAILED between the read and the claim: capture still settles", async () => {
    tx.payment.findUnique
      .mockResolvedValueOnce(side)
      .mockResolvedValueOnce({ paymentStatus: "FAILED" });
    tx.payment.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockTransition.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await handleOverageMemberSuccess("order_abc", 129_500);

    expect(tx.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "side1", paymentStatus: "FAILED" },
      data: { paymentStatus: "SUCCEEDED" },
    });
    expect(mockTransition).toHaveBeenLastCalledWith(
      tx,
      { paymentId: "side1" },
      "CHARGED",
      { settledAt: expect.any(Date) },
      { fromIn: ["FAILED"] },
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("capture on a tombstoned replaced order: parked and auto-refunded", async () => {
    tx.payment.findUnique.mockResolvedValue({
      ...side,
      id: "tomb1",
      paymentStatus: "EXPIRED",
      parentPaymentId: null,
    });

    await handleOverageMemberSuccess("order_old", 129_500, "pay_1");

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "tomb1", paymentStatus: "EXPIRED" },
      data: expect.objectContaining({
        paymentStatus: "SUCCEEDED",
        gatewayPaymentId: "pay_1",
      }),
    });
    expect(mockPost.mock.calls.map((c) => c[1].idempotencyKey)).toEqual([
      "unapplied:tomb1",
    ]);
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockRefund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "tomb1", amountPaise: 129_500 }),
    );
  });

  describe("a side payment already SUCCEEDED", () => {
    const captured = { ...side, paymentStatus: "SUCCEEDED" };
    const uncharged = expect.objectContaining({
      category: "OVERAGE",
      correlationId: "overage-captured-uncharged:side1",
    });

    it("is settled, and silent, only when its overage is CHARGED", async () => {
      tx.payment.findUnique.mockResolvedValue(captured);
      tx.overageEvent.findMany.mockResolvedValue([{ chargeStatus: "CHARGED" }]);

      await handleOverageMemberSuccess("order_abc", 129_500);

      expect(mockSystemError).not.toHaveBeenCalled();
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
    });

    it("is reported, and nothing is moved, when its overage was never charged", async () => {
      tx.payment.findUnique.mockResolvedValue(captured);
      tx.overageEvent.findMany.mockResolvedValue([{ chargeStatus: "PENDING" }]);

      await handleOverageMemberSuccess("order_abc", 129_500);

      expect(mockSystemError).toHaveBeenCalledTimes(1);
      expect(mockSystemError).toHaveBeenCalledWith(uncharged);
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("stays with the refund path when the capture is already being returned", async () => {
      tx.payment.findUnique.mockResolvedValue(captured);
      tx.overageEvent.findMany.mockResolvedValue([
        { chargeStatus: "REVERSED" },
      ]);
      tx.payment.count.mockResolvedValueOnce(0);

      await handleOverageMemberSuccess("order_abc", 129_500);

      expect(mockSystemError).not.toHaveBeenCalled();
    });
  });

  it("non-overage payment (no parentPaymentId) is ignored", async () => {
    tx.payment.findUnique.mockResolvedValue({ ...side, parentPaymentId: null });

    await handleOverageMemberSuccess("order_abc", 129_500);

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
