/**
 * @jest-environment node
 */

/**
 * A LICENSE-funded booking must reverse in the ledger, not just in earnings.
 *
 * `Payment.amount` for a licence booking is the full price; only the funding
 * LEG is zero, because the org's contract absorbs the per-booking cost and no
 * money moves. So the refund cascade's `legAmounts` — which filters
 * `amountPaise > 0` — came back empty, `fundingTotal` was 0, and the whole
 * double-entry block was skipped. Steps 6 and 7 had already incremented the
 * consultant's and the org's refunded share and flipped them REFUNDED.
 *
 * The booking journal DOES post for these: with no funding debit it debits
 * DISCOUNT for the gross and credits the payables and the platform fee
 * (earnings-service.ts). Skipping the reversal stranded those credits as
 * permanent EARNINGS_LEDGER_DRIFT that the reconciler flags and cannot repair.
 *
 * This suite deliberately does NOT stub `applyReversal` or `postLedgerTxn`'s
 * arithmetic — the sibling rails suite stubs the engine to check routing, which
 * means it cannot see this class of bug at all. Here the real cascade runs and
 * the emitted journal is inspected.
 */

const mockPostLedgerTxn = jest.fn();
const mockReverseBookingUtilization = jest.fn();
const mockRecordTdsReversal = jest.fn();
const mockWalletCredit = jest.fn();

jest.mock("../../lib/payments/ledger/refund-reversal-basis", () =>
  jest.requireActual("../fixtures/no-refund-reversal-basis"),
);
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: (...a: unknown[]) =>
    mockReverseBookingUtilization(...a),
}));

jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => mockRecordTdsReversal(...a),
}));

jest.mock("../../lib/api/organizations/wallet", () => ({
  walletCredit: (...a: unknown[]) => mockWalletCredit(...a),
}));

jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
    recordSystemEventSafe: jest.fn().mockResolvedValue(undefined),
  };
});

// The clawback notice has its own suite; the journal is what this file pins.
jest.mock("../../lib/payments/payouts/clawback-notifications", () => ({
  stageClawbackNotice: jest.fn(),
  stageRaisedClawback: jest.fn(),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import type { Posting } from "../../lib/payments/ledger/post";
import { applyRefundCascade } from "../../lib/payments/operations/refund";
import { txDouble } from "../fixtures/tx-double";

const PAYMENT_ID = "pay-license";
const REFUND_ID = "refund-1";
const CONSULTANT = "cp-1";
const ORG = "org-1";

/**
 * ₹10,000 licence booking. Consultant keeps 7,000, the host org 2,000, the
 * platform 1,000. Its taxAmount is 0: the licence invoice books the GST.
 */
const GROSS = 1_000_000;
const TAX = 0;
const CONSULTANT_SHARE = 700_000;
const ORG_SHARE = 200_000;

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    amount: GROSS,
    originalAmount: GROSS,
    taxAmount: TAX,
    createdAt: new Date(),
    organizationId: ORG,
    billingAccountId: null,
    billableToOrgInvoiceId: null,
    parentPaymentId: null,
    // The whole point: one leg, worth nothing.
    legs: [
      {
        id: "leg-1",
        source: "LICENSE",
        amountPaise: 0,
        sourceRef: "assignment-1",
      },
    ],
    earnings: [
      {
        id: "earn-1",
        consultantProfileId: CONSULTANT,
        consultantSharePaise: CONSULTANT_SHARE,
        refundedShareAmount: 0,
        status: "PENDING",
        payoutId: null,
      },
    ],
    organizationEarnings: [
      {
        id: "oe-1",
        organizationId: ORG,
        orgSharePaise: ORG_SHARE,
        refundedAmountPaise: 0,
        status: "PENDING",
        orgPayoutId: null,
        orgPayout: null,
      },
    ],
    bookingUtilization: { id: "util-1", engagementsConsumed: 1 },
    // #1582 C-P0-03 — the cascade reads the cumulative cap through these.
    refunds: [],
    disputes: [],
    ...overrides,
  };
}

let payment: ReturnType<typeof paymentRow>;

function txStub() {
  return {
    refund: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: {
      findUniqueOrThrow: jest.fn(async () => payment),
      findUnique: jest.fn(async () => payment),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // W1c — the earnings REFUNDED writers moved from a plain `update` to a
    // CAS `updateMany` (source status in WHERE, `refundedShareAmount` pinned to
    // the pre-read). Keep the surface complete so this suite fails on an
    // assertion rather than on `updateMany is not a function`.
    // The owed-refund stamp cancels the unsent payouts that batched the payment's earnings; none here.
    consultantEarnings: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    organizationEarnings: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    organizationPayout: { update: jest.fn().mockResolvedValue({}) },
    consultantPayout: { update: jest.fn().mockResolvedValue({}) },
    organizationInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    creditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    // #1365 — the B2C sibling mint probes both of these and no-ops when the
    // payment has no consumer invoice, which is the case in every fixture here.
    consumerCreditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    consumerInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    overageEvent: { findMany: jest.fn().mockResolvedValue([]) },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    paymentLeg: { upsert: jest.fn().mockResolvedValue({}) },
    ledgerTransaction: { findUnique: jest.fn().mockResolvedValue(null) },
    ledgerEntry: { findMany: jest.fn().mockResolvedValue([]) },
    organization: { findUnique: jest.fn().mockResolvedValue(null) },
    recordingPurchase: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    digitalProductPurchase: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

/** The postings the cascade emitted, flattened. */
function emittedPostings(): Posting[] {
  expect(mockPostLedgerTxn).toHaveBeenCalled();
  return mockPostLedgerTxn.mock.calls[0][1].postings as Posting[];
}

function sum(postings: Posting[], direction: "DEBIT" | "CREDIT"): number {
  return postings
    .filter((p) => p.direction === direction)
    .reduce((s, p) => s + p.amountPaise, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  payment = paymentRow();
  mockPostLedgerTxn.mockResolvedValue({ id: "txn-1" });
  mockReverseBookingUtilization.mockResolvedValue({
    reversed: true,
    engagementsReversed: 1,
    fullyReversed: true,
  });
});

describe("a full refund of a LICENSE-funded booking", () => {
  it("posts a reversal journal at all", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    // This is the bug: the block was skipped entirely because every funding
    // leg was worth zero, while the earnings were reversed regardless.
    expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
    expect(mockPostLedgerTxn.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        idempotencyKey: `refund:${REFUND_ID}`,
        kind: "REFUND",
        paymentId: PAYMENT_ID,
      }),
    );
  });

  it("balances to the paise", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    const postings = emittedPostings();
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));
    expect(sum(postings, "DEBIT")).toBeGreaterThan(0);
  });

  it("returns the funding to DISCOUNT, mirroring the booking journal", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    const credits = emittedPostings().filter((p) => p.direction === "CREDIT");
    // The booking debited DISCOUNT for the gross because no funding leg
    // carried money; the reversal credits the same account for the same total.
    expect(credits).toEqual([
      expect.objectContaining({
        account: expect.objectContaining({ kind: "DISCOUNT" }),
        amountPaise: GROSS + TAX,
      }),
    ]);
  });

  it("debits back every share the booking credited", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    const debits = emittedPostings().filter((p) => p.direction === "DEBIT");
    const byKind = Object.fromEntries(
      debits.map((d) => [d.account.kind, d.amountPaise]),
    );

    expect(byKind.CONSULTANT_PAYABLE).toBe(CONSULTANT_SHARE);
    expect(byKind.ORG_PAYABLE).toBe(ORG_SHARE);
    expect(byKind.GST_PAYABLE).toBeUndefined();
    // The residual is the platform's own cut, returned in full.
    expect(byKind.PLATFORM_FEE).toBe(GROSS - CONSULTANT_SHARE - ORG_SHARE);
  });

  it("still returns the engagement to the program cap", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    expect(mockReverseBookingUtilization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: PAYMENT_ID }),
    );
  });
});

describe("a refund of a LICENSE-funded booking whose consultant was already paid", () => {
  it("raises the consultant's receivable for the paid share, net of TDS, and keeps the organisation's refund audit entry", async () => {
    // The ₹7,000 share left in a COMPLETED payout that withheld ₹700.
    payment = paymentRow({
      earnings: [
        {
          id: "earn-1",
          consultantProfileId: CONSULTANT,
          consultantSharePaise: CONSULTANT_SHARE,
          refundedShareAmount: 0,
          status: "PAID",
          payoutId: "cpo-1",
          payout: {
            status: "COMPLETED",
            amount: CONSULTANT_SHARE,
            tdsDeducted: 70_000,
            clawbackInitiatedAt: null,
          },
        },
      ],
    });

    const tx = txStub();
    const result = await applyRefundCascade(tx as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    expect(result.clawbackInitiated).toBe(true);
    // The organisation's own earning was unpaid, so no payout clawback row
    // stands in for its refund entry in the organisation's audit feed.
    expect(tx.orgAuditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        action: "INVOICE_REFUNDED",
        details: expect.objectContaining({ refundId: REFUND_ID }),
      }),
    });
    // The payout's own counter moves with the journal, by the same net figure.
    expect(tx.consultantPayout.update).toHaveBeenCalledTimes(1);
    expect(tx.consultantPayout.update).toHaveBeenCalledWith({
      where: { id: "cpo-1" },
      data: {
        clawbackAmountPaise: { increment: 630_000 },
        clawbackInitiatedAt: expect.any(Date),
      },
    });
    const clawback = mockPostLedgerTxn.mock.calls
      .map((call) => call[1])
      .find((input) => input.idempotencyKey.startsWith("clawback:"));
    expect(clawback).toMatchObject({
      idempotencyKey: `clawback:${REFUND_ID}:cpo-1`,
      payoutId: "cpo-1",
      postings: [
        {
          account: {
            kind: "CONSULTANT_RECEIVABLE",
            consultantProfileId: CONSULTANT,
          },
          direction: "DEBIT",
          amountPaise: 630_000,
        },
        {
          account: {
            kind: "CONSULTANT_PAYABLE",
            consultantProfileId: CONSULTANT,
          },
          direction: "CREDIT",
          amountPaise: 630_000,
        },
      ],
    });
  });
});

describe("a half refund of a LICENSE-funded booking", () => {
  it("balances, and reverses exactly half of every share", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS / 2,
      reason: "partial cancellation",
    });

    const postings = emittedPostings();
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));

    const byKind = Object.fromEntries(
      postings
        .filter((p) => p.direction === "DEBIT")
        .map((d) => [d.account.kind, d.amountPaise]),
    );
    expect(byKind.CONSULTANT_PAYABLE).toBe(CONSULTANT_SHARE / 2);
    expect(byKind.ORG_PAYABLE).toBe(ORG_SHARE / 2);
    expect(byKind.GST_PAYABLE).toBeUndefined();
  });
});

describe("bookings that genuinely have nothing to reverse", () => {
  it("posts no journal when there are no earnings either", async () => {
    payment = paymentRow({ earnings: [], organizationEarnings: [] });

    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    // No share was ever credited, so there is nothing to take back. Inventing
    // a DISCOUNT credit here would fabricate a one-sided journal.
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });
});

/** An earlier refund whose cascade already ran. */
const cascaded = {
  status: "SUCCEEDED",
  cascadedAt: new Date("2026-10-01T00:00:00Z"),
  deletedAt: null,
};

describe("a replay sale's playback", () => {
  it("survives a partial refund and is revoked once the charge is fully refunded", async () => {
    const replay = { appointmentId: null, paymentIntent: "order_replay" };
    payment = paymentRow({
      ...replay,
      refunds: [{ id: "rf-0", amountPaise: GROSS / 2, status: "PENDING" }],
    });
    const partialTx = txStub();
    await applyRefundCascade(partialTx as never, {
      paymentId: PAYMENT_ID,
      refundId: "rf-0",
      amountPaise: GROSS / 2,
      reason: "goodwill",
    });
    expect(partialTx.recordingPurchase.updateMany).not.toHaveBeenCalled();

    payment = paymentRow({
      ...replay,
      refunds: [{ id: "rf-0", amountPaise: GROSS / 2, ...cascaded }],
    });
    const fullTx = txStub();
    await applyRefundCascade(fullTx as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS / 2,
      reason: "rest of the charge",
    });
    expect(fullTx.recordingPurchase.updateMany).toHaveBeenCalledWith({
      where: { gatewayOrderId: "order_replay", status: "SUCCEEDED" },
      data: { status: "REFUNDED" },
    });
  });
});

describe("a past-cutoff refund of a taxed member overage side-payment", () => {
  it("reverses the capture's own credits; the platform bears the kept GST", async () => {
    payment = paymentRow({
      amount: 29_500,
      originalAmount: 25_000,
      taxAmount: 4_500,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      parentPaymentId: "parent-1",
      legs: [{ id: "leg-c", source: "CARD", amountPaise: 29_500 }],
      earnings: [],
      organizationEarnings: [],
      bookingUtilization: null,
    });
    const tx = txStub();
    const captured = (kind: string, paise: number) => ({
      accountId: `${kind}|_|_|INR`,
      direction: "CREDIT",
      amountPaise: BigInt(paise),
      account: { kind, organizationId: null },
      transaction: { kind: "OVERAGE_MEMBER" },
    });
    tx.ledgerEntry.findMany.mockResolvedValue([
      captured("DISCOUNT", 20_000),
      captured("PLATFORM_FEE", 5_000),
    ]);

    await applyRefundCascade(txDouble(tx), {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: 29_500,
      reason: "cancellation",
    });

    const postings = emittedPostings();
    const debit = (kind: string) =>
      sum(
        postings.filter((p) => p.account.kind === kind),
        "DEBIT",
      );
    expect(debit("DISCOUNT")).toBe(20_000);
    expect(debit("PLATFORM_FEE")).toBe(5_000 + 4_500);
    expect(debit("ORG_PAYABLE")).toBe(0);
    expect(debit("GST_PAYABLE")).toBe(0);
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));
  });
});

describe("charged batch overages on a partial refund then the remainder", () => {
  const charged = [
    {
      id: "ov-org",
      overageBehavior: "CHARGE_ORG",
      paymentId: PAYMENT_ID,
      invoiceLineItemId: null,
    },
    ...["side-1", "side-2", "side-3"].map((paymentId) => ({
      id: `ov-${paymentId}`,
      overageBehavior: "CHARGE_MEMBER",
      paymentId,
      invoiceLineItemId: null,
    })),
  ];
  const { transitionOverage } = jest.requireMock(
    "../../lib/payments/billing/overage-transitions",
  );

  // The WALLET leg collected the CHARGE_ORG marginal inside the booking payment.
  const walletParent = {
    billingAccountId: "ba-1",
    legs: [
      { id: "leg-w", source: "WALLET", amountPaise: GROSS, sourceRef: "a-1" },
    ],
  };

  it("credits them back once, on the refund that completes the full refund", async () => {
    mockWalletCredit.mockResolvedValue({ ownerOrgId: ORG });
    payment = paymentRow({
      ...walletParent,
      refunds: [{ id: "rf-0", amountPaise: GROSS / 4, status: "SUCCEEDED" }],
    });
    const partialTx = txStub();
    partialTx.overageEvent.findMany.mockResolvedValue(charged);
    await applyRefundCascade(partialTx as never, {
      paymentId: PAYMENT_ID,
      refundId: "rf-0",
      amountPaise: GROSS / 4,
      reason: "goodwill",
    });
    expect(partialTx.payment.updateMany).not.toHaveBeenCalled();
    expect(transitionOverage).not.toHaveBeenCalledWith(
      expect.anything(),
      { id: "ov-org" },
      "REVERSED",
      expect.anything(),
      expect.anything(),
    );

    mockWalletCredit.mockClear();
    payment = paymentRow({
      ...walletParent,
      refunds: [
        { id: "rf-0", amountPaise: GROSS / 4, ...cascaded },
        { id: REFUND_ID, amountPaise: (GROSS * 3) / 4, status: "SUCCEEDED" },
      ],
    });
    const restTx = txStub();
    restTx.overageEvent.findMany.mockResolvedValue(charged);
    await applyRefundCascade(restTx as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: (GROSS * 3) / 4,
      reason: "cancellation",
    });
    expect(transitionOverage).toHaveBeenCalledWith(
      expect.anything(),
      { id: "ov-org" },
      "REVERSED",
      expect.objectContaining({ reversedAt: expect.any(Date) }),
      { fromIn: ["CHARGED"] },
    );
    expect(mockWalletCredit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        billingAccountId: "ba-1",
        amountPaise: (GROSS * 3) / 4,
      }),
    );
    // Every side-payment is stamped refund-owed in this tx; the sweep refunds them.
    expect(
      restTx.payment.updateMany.mock.calls.map(
        ([arg]) => arg.data.refundOwedKey,
      ),
    ).toEqual(
      ["side-1", "side-2", "side-3"].map(
        (id) => `overage-credit-back:${PAYMENT_ID}:${id}`,
      ),
    );
  });
});
