/**
 * @jest-environment node
 */
import {
  invoiceRefundDebits,
  postInvoiceIssuedJournal,
  postInvoiceVoidedJournal,
} from "@/lib/payments/billing/org-invoice-journal";
import type { Posting } from "@/lib/payments/ledger/post";
import type { Tx } from "@/lib/prisma";

const mockPost = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...args: unknown[]) => mockPost(...args),
}));

const invoice = {
  organizationId: "org1",
  subtotalPaise: 100_000,
  igstPaise: 18_000,
  cgstPaise: 0,
  sgstPaise: 0,
  totalPaise: 118_000,
  billedPayments: [] as { id: string }[],
  lineItems: [] as { id: string }[],
};

function makeTx(issued: unknown, note: unknown = null): Tx {
  const mock: object = {
    organizationInvoice: { findUniqueOrThrow: jest.fn(async () => invoice) },
    ledgerTransaction: { findUnique: jest.fn(async () => issued) },
    creditNote: { findUnique: jest.fn(async () => note) },
  };
  return mock as Tx;
}

const net = (postings: Posting[], kind: string) =>
  postings
    .filter((p) => p.account.kind === kind)
    .reduce(
      (s, p) => s + (p.direction === "DEBIT" ? p.amountPaise : -p.amountPaise),
      0,
    );

beforeEach(() => mockPost.mockReset());

describe("org invoice issue journal", () => {
  it("books receivable, fee and GST at issue, and void posts the exact mirror", async () => {
    expect(await postInvoiceIssuedJournal(makeTx(null), "inv1")).toBe("POSTED");
    const issue = mockPost.mock.calls[0][1];
    expect(issue.idempotencyKey).toBe("invoice-issued:inv1");
    expect(net(issue.postings, "ORG_RECEIVABLE")).toBe(118_000);
    expect(net(issue.postings, "PLATFORM_FEE")).toBe(-100_000);
    expect(net(issue.postings, "GST_PAYABLE")).toBe(-18_000);

    const entries = issue.postings.map((p: Posting) => ({
      direction: p.direction,
      amountPaise: BigInt(p.amountPaise),
      account: { ...p.account, consultantProfileId: null, currency: "INR" },
    }));
    expect(await postInvoiceVoidedJournal(makeTx({ entries }), "inv1")).toBe(
      true,
    );
    const voided = mockPost.mock.calls[1][1];
    expect(voided.idempotencyKey).toBe("invoice-voided:inv1");
    for (const kind of ["ORG_RECEIVABLE", "PLATFORM_FEE", "GST_PAYABLE"]) {
      expect(net(voided.postings, kind)).toBe(-net(issue.postings, kind));
    }
  });

  it("never posts for an invoice that bills bookings (their journals booked the GST)", async () => {
    const tx = makeTx(null);
    invoice.billedPayments = [{ id: "pay1" }];
    try {
      expect(await postInvoiceIssuedJournal(tx, "inv1")).toBe("BILLS_BOOKINGS");
    } finally {
      invoice.billedPayments = [];
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("a refund past the s.34(2) cutoff keeps the GST: the whole amount comes off the fee", async () => {
    const commercialNote = { igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
    const debits = await invoiceRefundDebits(
      makeTx({ id: "txn" }, commercialNote),
      {
        invoiceId: "inv1",
        organizationId: "org1",
        amountPaise: 59_000,
        creditNoteId: "cn1",
      },
    );
    expect(net(debits, "PLATFORM_FEE")).toBe(59_000);
    expect(net(debits, "GST_PAYABLE")).toBe(0);

    const taxNote = { igstPaise: 9_000, cgstPaise: 0, sgstPaise: 0 };
    const inTime = await invoiceRefundDebits(makeTx({ id: "txn" }, taxNote), {
      invoiceId: "inv1",
      organizationId: "org1",
      amountPaise: 59_000,
      creditNoteId: "cn2",
    });
    expect(net(inTime, "PLATFORM_FEE")).toBe(50_000);
    expect(net(inTime, "GST_PAYABLE")).toBe(9_000);
  });
});
