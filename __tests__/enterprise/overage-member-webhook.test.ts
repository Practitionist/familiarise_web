/**
 * @jest-environment node
 */

/**
 * #775/#782 — CHARGE_MEMBER side-charge capture webhook.
 *
 * Pins the settlement contract the OVERAGE_SETTLEMENT_MISMATCH reconcile
 * invariant asserts: a capture flips the side-Payment → SUCCEEDED, moves the
 * event PENDING/FAILED → CHARGED, and ONLY THEN posts the org-relief journal
 * (`overage:<sidePaymentId>`: Dr CASH / Cr ORG_PAYABLE == marginalPaise).
 * If the event can't legally reach CHARGED (REVERSED mid-flight), no org
 * credit is posted and the collected money is escalated for refund.
 */

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentLeg: { upsert: jest.fn() },
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
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  restoreOverageBaseCarve: jest.fn().mockResolvedValue("restored"),
  recarveOverageBase: jest.fn().mockResolvedValue("recarved"),
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
      payment: { findUnique: jest.Mock; updateMany: jest.Mock };
      paymentLeg: { upsert: jest.Mock };
    };
  }
).__tx;
const mockTransition = transitionOverage as jest.Mock;
const mockPost = postLedgerTxn as jest.Mock;
const mockSystemError = recordSystemError as jest.Mock;

const side = {
  id: "side1",
  amount: 125_000,
  taxAmount: 0,
  organizationId: "org1",
  paymentStatus: "PENDING",
  parentPaymentId: "parent1",
};

beforeEach(() => {
  jest.clearAllMocks();
  tx.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe("handleOverageMemberSuccess", () => {
  it("capture: SUCCEEDED + CHARGED, then Dr CASH / Cr ORG_PAYABLE == marginal", async () => {
    tx.payment.findUnique.mockResolvedValue(side);
    mockTransition.mockResolvedValue(1);

    await handleOverageMemberSuccess("order_abc");

    // #1846 SM-B2 — the status just read rides the WHERE.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "side1", paymentStatus: "PENDING" },
      data: { paymentStatus: "SUCCEEDED" },
    });
    // funding-invariant CARD leg, idempotent upsert
    expect(tx.paymentLeg.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: "CARD",
          amountPaise: 125_000,
        }),
        update: {},
      }),
    );
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
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 125_000 },
        {
          account: { kind: "ORG_PAYABLE", organizationId: "org1" },
          direction: "CREDIT",
          amountPaise: 125_000,
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

    await handleOverageMemberSuccess("order_abc");

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("capture racing a reversal (event REVERSED): no org credit, escalates for refund", async () => {
    tx.payment.findUnique.mockResolvedValue(side);
    mockTransition.mockResolvedValue(0); // REVERSED not in CHARGED's allowed-from

    await handleOverageMemberSuccess("order_abc");

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        category: "OVERAGE",
        context: expect.objectContaining({ sidePaymentId: "side1" }),
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

    await handleOverageMemberSuccess("order_abc");

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

  it("non-overage payment (no parentPaymentId) is ignored", async () => {
    tx.payment.findUnique.mockResolvedValue({ ...side, parentPaymentId: null });

    await handleOverageMemberSuccess("order_abc");

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
