/**
 * @jest-environment node
 */

/**
 * Shared refund credit-note minting (#776 / #778 §D). `mintRefundCreditNote` is
 * called from BOTH applyRefundCascade (app/cron) and the gateway-refund webhook,
 * so it must be idempotent on refundId (one CN per refund, no duplicate, no
 * burned sequence number) and a no-op for non-invoiced payments. Mocked tx.
 */

import { mintRefundCreditNote } from "@/lib/payments/operations/refund";

function mockTx(opts: {
  payment: {
    id: string;
    amount: number;
    organizationId: string | null;
    billableToOrgInvoiceId: string | null;
    legs: Array<{ source: string; amountPaise: number }>;
  } | null;
  existingCreditNote?: { id: string } | null;
}) {
  const creditNoteCreate = jest
    .fn()
    .mockImplementation(async () => ({ id: "cn-new" }));
  return {
    _creditNoteCreate: creditNoteCreate,
    payment: { findUnique: jest.fn().mockResolvedValue(opts.payment) },
    creditNote: {
      findUnique: jest.fn().mockResolvedValue(opts.existingCreditNote ?? null),
      create: creditNoteCreate,
    },
    organizationInvoice: {
      findUnique: jest.fn().mockResolvedValue({
        id: "inv1",
        totalPaise: 1180,
        igstPaise: 0,
        cgstPaise: 90,
        sgstPaise: 90,
      }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        id: "org1",
        slug: "acme",
        invoiceNumberPrefix: "ACME",
      }),
    },
    orgCreditNoteCounter: {
      upsert: jest.fn().mockResolvedValue({ nextSeq: 2 }),
    },
  };
}

const INVOICED_PAYMENT = {
  id: "p1",
  amount: 1000,
  organizationId: "org1",
  billableToOrgInvoiceId: "inv1",
  legs: [{ source: "INVOICE_ACCRUAL", amountPaise: 1000 }],
};

describe("mintRefundCreditNote", () => {
  it("mints a credit note for an invoiced refund", async () => {
    const tx = mockTx({ payment: INVOICED_PAYMENT });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBe("cn-new");
    expect(tx._creditNoteCreate).toHaveBeenCalledTimes(1);
    const data = tx._creditNoteCreate.mock.calls[0][0].data;
    expect(data.refundId).toBe("ref1");
    expect(data.invoiceId).toBe("inv1");
    expect(data.totalPaise).toBe(1000);
    expect(data.creditNoteNumber).toBe("ACME-CN-2026-0001");
  });

  it("is idempotent — returns the existing note and does NOT create a second", async () => {
    const tx = mockTx({
      payment: INVOICED_PAYMENT,
      existingCreditNote: { id: "cn-existing" },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBe("cn-existing");
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
    expect(tx.orgCreditNoteCounter.upsert).not.toHaveBeenCalled();
  });

  it("is a no-op for a non-invoiced payment", async () => {
    const tx = mockTx({
      payment: {
        ...INVOICED_PAYMENT,
        billableToOrgInvoiceId: null,
        organizationId: null,
      },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBeNull();
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
  });

  it("is a no-op when no invoice-accrual legs are present", async () => {
    const tx = mockTx({
      payment: {
        ...INVOICED_PAYMENT,
        legs: [{ source: "CARD", amountPaise: 1000 }],
      },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBeNull();
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
  });
});
