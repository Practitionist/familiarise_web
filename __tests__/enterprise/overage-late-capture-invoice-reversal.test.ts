/**
 * @jest-environment node
 */

/**
 * #812 — a FAILED→CHARGED late member capture whose PARENT was already rolled
 * onto an org invoice.
 *
 * `recarveOverageBase` refuses to touch an issued document and answers
 * `"invoiced"`, so the base is still billed to the org on that invoice. The
 * capture is still honoured (the gateway took the money) and credits the base to
 * DISCOUNT, so the base would be collected twice: on the invoice and from the member.
 *
 * The correction under test: move the member's base onto the org's receivable
 * with an append-only, ledger-keyed counter-transaction, hand it back on the
 * invoice as a CGST Sec 34 credit note, and record it durably inside the capture tx.
 *
 * INVARIANT PINNED HERE: the org is never credited a payable for a member overage.
 */

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentLeg: { updateMany: jest.fn() },
    overageEvent: { findFirst: jest.fn() },
    organizationInvoice: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
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
  postLedgerTxn: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  restoreOverageBaseCarve: jest.fn().mockResolvedValue("restored"),
  recarveOverageBase: jest.fn().mockResolvedValue("recarved"),
  releaseOverageHeldParentEarnings: jest.fn().mockResolvedValue(undefined),
}));
const mockRefund = jest.fn().mockResolvedValue({ status: "SUCCEEDED" });
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefund(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  mintInvoiceRefundCreditNote: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
    recordSystemEventSafe: recordSystemError,
  };
});

import prisma from "../../lib/prisma";
import { postLedgerTxn } from "../../lib/payments/ledger/post";
import { transitionOverage } from "../../lib/payments/billing/overage-transitions";
import { recarveOverageBase } from "../../lib/payments/billing/overage-base-carve";
import { mintInvoiceRefundCreditNote } from "../../lib/payments/operations/refund";
import { recordSystemError } from "../../lib/enterprise/system-events";
import { handleOverageMemberSuccess } from "../../lib/payments/webhooks/overage-handlers";

type MockTx = {
  payment: { findUnique: jest.Mock; updateMany: jest.Mock };
  paymentLeg: { updateMany: jest.Mock };
  overageEvent: { findFirst: jest.Mock };
  organizationInvoice: { findUnique: jest.Mock; updateMany: jest.Mock };
};
type MockPosting = {
  account: { kind: string; organizationId?: string };
  direction: string;
  amountPaise: number;
};
type MockTxn = { idempotencyKey: string; postings: MockPosting[] };

const tx = (prisma as unknown as { __tx: MockTx }).__tx;
const mockTransition = transitionOverage as jest.Mock;
const mockPost = postLedgerTxn as jest.Mock;
const mockRecarve = recarveOverageBase as jest.Mock;
const mockMint = mintInvoiceRefundCreditNote as jest.Mock;
const mockSystemError = recordSystemError as jest.Mock;

/** base 100_000 + surcharge 25_000 — `computeOverage`: marginal == side.amount. */
const BASE = 100_000;
const SURCHARGE = 25_000;
const MARGINAL = BASE + SURCHARGE;
const REVERSAL_KEY = "overage-recarve-invoice:side1";

const side = {
  id: "side1",
  amount: MARGINAL,
  taxAmount: 0,
  organizationId: "org1",
  // The abandoned sweep FAILed it, so the recarve edge (FAILED→CHARGED) fires.
  paymentStatus: "FAILED",
  parentPaymentId: "parent1",
};

const invoicedParent = {
  id: "oe1",
  basePaise: BASE,
  payment: { parentPayment: { billableToOrgInvoiceId: "inv1" } },
};

/** An 18% GST invoice whose subtotal is the restored base. */
const INVOICE = {
  invoiceNumber: "ACME-2026-0001",
  subtotalPaise: 100_000,
  igstPaise: 0,
  cgstPaise: 9_000,
  sgstPaise: 9_000,
};

/**
 * A miniature of the real helper: append-only, and a repeated
 * `idempotencyKey` is a no-op (@unique is the hard guard). Only applied
 * transactions land in `applied`, so the balances below are what the JOURNAL
 * would actually say after any number of deliveries.
 */
let applied: MockTxn[] = [];
function netPosted(accountKind: string, organizationId: string): number {
  let net = 0;
  for (const txn of applied) {
    for (const p of txn.postings) {
      if (p.account.kind !== accountKind) continue;
      if (p.account.organizationId !== organizationId) continue;
      net += p.direction === "CREDIT" ? p.amountPaise : -p.amountPaise;
    }
  }
  return net;
}
const appliedKeys = () => applied.map((t) => t.idempotencyKey);

beforeEach(() => {
  jest.clearAllMocks();
  applied = [];
  mockPost.mockImplementation(async (_db: unknown, input: MockTxn) => {
    if (applied.some((t) => t.idempotencyKey === input.idempotencyKey)) {
      return { transactionId: input.idempotencyKey, created: false };
    }
    applied.push({
      idempotencyKey: input.idempotencyKey,
      postings: input.postings,
    });
    return { transactionId: input.idempotencyKey, created: true };
  });
  tx.payment.updateMany.mockResolvedValue({ count: 1 });
  tx.payment.findUnique.mockResolvedValue(side);
  tx.overageEvent.findFirst.mockResolvedValue(invoicedParent);
  tx.organizationInvoice.findUnique.mockResolvedValue(INVOICE);
  mockMint.mockResolvedValue({ creditNoteId: "cn1" });
  mockRecarve.mockResolvedValue("recarved");
  // PENDING/ACCRUED→CHARGED misses; the FAILED→CHARGED recovery edge fires.
  mockTransition.mockResolvedValueOnce(0).mockResolvedValue(1);
});

describe("late capture after the parent was invoiced", () => {
  it("moves the member's base onto the org's receivable", async () => {
    mockRecarve.mockResolvedValue("invoiced");

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    // The capture journal is unchanged, under the key the
    // OVERAGE_SETTLEMENT_MISMATCH reconcile invariant joins on.
    expect(mockPost).toHaveBeenNthCalledWith(1, tx, {
      idempotencyKey: "overage:side1",
      kind: "OVERAGE_MEMBER",
      paymentId: "side1",
      postings: [
        {
          account: { kind: "GATEWAY_CLEARING" },
          direction: "DEBIT",
          amountPaise: MARGINAL,
        },
        {
          account: { kind: "DISCOUNT" },
          direction: "CREDIT",
          amountPaise: BASE,
        },
        {
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise: SURCHARGE,
        },
      ],
    });

    // …and the base moves onto the org's receivable by a second,
    // append-only counter-transaction keyed on the same side payment.
    expect(mockPost).toHaveBeenNthCalledWith(2, tx, {
      idempotencyKey: REVERSAL_KEY,
      kind: "OVERAGE_MEMBER",
      paymentId: "side1",
      invoiceId: "inv1",
      description: expect.stringContaining("side1"),
      postings: [
        {
          account: { kind: "DISCOUNT" },
          direction: "DEBIT",
          amountPaise: BASE,
        },
        {
          account: { kind: "ORG_RECEIVABLE", organizationId: "org1" },
          direction: "CREDIT",
          amountPaise: BASE,
        },
      ],
    });

    expect(netPosted("ORG_PAYABLE", "org1")).toBe(0);
    expect(netPosted("ORG_RECEIVABLE", "org1")).toBe(BASE);
    // The base is credited back on the invoice the org already received, as a
    // tax-inclusive Sec-34 amount (base grossed up at the invoice's own 18%).
    expect(mockMint).toHaveBeenCalledWith(tx, {
      invoiceId: "inv1",
      // #1894 — the note names its real trigger, never a borrowed refundId.
      overageEventId: "oe1",
      amountPaise: 118_000,
      exactSubtotalPaise: BASE,
      reason: expect.stringContaining("side1"),
    });
  });

  it("the diagnostic is durable — awaited and written through the transaction", async () => {
    mockRecarve.mockResolvedValue("invoiced");
    let diagnosticSettled = false;
    mockSystemError.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      diagnosticSettled = true;
    });

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    // `db: tx` routes the insert through the capture transaction, so it
    // commits — and rolls back — with the correction, instead of racing it on
    // the global client where a crash loses the only record.
    expect(mockSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        db: tx,
        organizationId: "org1",
        category: "OVERAGE",
        context: expect.objectContaining({
          sidePaymentId: "side1",
          invoiceId: "inv1",
          basePaise: BASE,
          creditNoteId: "cn1",
          ledgerReversalKey: REVERSAL_KEY,
        }),
      }),
    );
    // Awaited, not `void`ed: fully written before the webhook returns.
    expect(diagnosticSettled).toBe(true);
  });

  it("a retry with the same side payment id applies once", async () => {
    mockRecarve.mockResolvedValue("invoiced");

    await handleOverageMemberSuccess("order_abc", MARGINAL);
    const firstKeys = appliedKeys();
    const firstMint = mockMint.mock.calls[0][1];
    const firstMintCount = mockMint.mock.calls.length;
    // Delivery replay: the side-payment is still FAILED (the first attempt's tx
    // rolled back), so the CAS claims it again and the correction re-runs.
    // Nothing random may enter the keys — @unique idempotency is the guard.
    tx.payment.findUnique.mockResolvedValue(side);
    mockTransition.mockReset().mockResolvedValueOnce(0).mockResolvedValue(1);

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    expect(mockPost).toHaveBeenCalledTimes(4); // 2 per attempt, all re-posted
    expect(appliedKeys()).toEqual(firstKeys); // none of them applied twice
    expect(firstKeys).toEqual(["overage:side1", REVERSAL_KEY]);
    expect(netPosted("ORG_RECEIVABLE", "org1")).toBe(BASE);
    // The credit note is keyed on the same deterministic trigger, so the
    // canonical writer's own probe collapses the second attempt to a re-read.
    expect(mockMint).toHaveBeenCalledTimes(firstMintCount + 1);
    expect(mockMint).toHaveBeenLastCalledWith(tx, firstMint);
  });

  it("no parent invoice link: nothing to reverse, and it says so durably", async () => {
    mockRecarve.mockResolvedValue("invoiced");
    tx.overageEvent.findFirst.mockResolvedValue({
      basePaise: BASE,
      payment: { parentPayment: { billableToOrgInvoiceId: null } },
    });

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    expect(appliedKeys()).toEqual(["overage:side1"]);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        db: tx,
        context: expect.objectContaining({ sidePaymentId: "side1" }),
      }),
    );
  });

  it("neutralising two overage events sequentially on the same ISSUED invoice mints two full credit notes and clears providerPaymentOrderId", async () => {
    mockRecarve.mockResolvedValue("invoiced");
    tx.organizationInvoice.findUnique.mockResolvedValue({
      invoiceNumber: "ACME-2026-0001",
      subtotalPaise: 200_000,
      igstPaise: 0,
      cgstPaise: 18_000,
      sgstPaise: 18_000,
    });
    mockMint
      .mockResolvedValueOnce({ creditNoteId: "cn1" })
      .mockResolvedValueOnce({ creditNoteId: "cn2" });

    // First overage event on inv1
    await handleOverageMemberSuccess("order_abc_1", MARGINAL);

    // Second overage event on the same inv1
    tx.payment.findUnique.mockResolvedValue({
      ...side,
      id: "side2",
      parentPaymentId: "parent2",
    });
    tx.overageEvent.findFirst.mockResolvedValue({
      id: "oe2",
      basePaise: BASE,
      payment: { parentPayment: { billableToOrgInvoiceId: "inv1" } },
    });
    mockTransition.mockReset().mockResolvedValueOnce(0).mockResolvedValue(1);

    await handleOverageMemberSuccess("order_abc_2", MARGINAL);

    expect(mockMint).toHaveBeenNthCalledWith(1, tx, {
      invoiceId: "inv1",
      overageEventId: "oe1",
      amountPaise: 118_000,
      exactSubtotalPaise: BASE,
      reason: expect.stringContaining("side1"),
    });
    expect(mockMint).toHaveBeenNthCalledWith(2, tx, {
      invoiceId: "inv1",
      overageEventId: "oe2",
      amountPaise: 118_000,
      exactSubtotalPaise: BASE,
      reason: expect.stringContaining("side2"),
    });
    expect(tx.organizationInvoice.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.organizationInvoice.updateMany).toHaveBeenCalledWith({
      where: { id: "inv1", providerPaymentOrderId: { not: null } },
      data: { providerPaymentOrderId: null },
    });
    expect(netPosted("ORG_RECEIVABLE", "org1")).toBe(2 * BASE);
  });
});

describe("unchanged paths", () => {
  it("normal capture (PENDING→CHARGED) posts the capture and nothing else", async () => {
    tx.payment.findUnique.mockResolvedValue({
      ...side,
      paymentStatus: "PENDING",
    });
    mockTransition.mockReset().mockResolvedValue(1);

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    expect(mockRecarve).not.toHaveBeenCalled();
    expect(appliedKeys()).toEqual(["overage:side1"]);
    expect(netPosted("ORG_PAYABLE", "org1")).toBe(0);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockSystemError).not.toHaveBeenCalled();
  });

  it("late capture whose parent is NOT invoiced: recarve succeeds, no reversal", async () => {
    mockRecarve.mockResolvedValue("recarved");

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    expect(appliedKeys()).toEqual(["overage:side1"]);
    expect(netPosted("ORG_PAYABLE", "org1")).toBe(0);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockSystemError).not.toHaveBeenCalled();
  });

  it("capture racing a reversal (moved === 0): no org credit, no reversal, cash parked and refunded", async () => {
    mockTransition.mockReset().mockResolvedValue(0);

    await handleOverageMemberSuccess("order_abc", MARGINAL);

    const keys = mockPost.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys).toEqual(["unapplied:side1"]);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockRefund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "side1", amountPaise: MARGINAL }),
    );
  });
});
