/**
 * @jest-environment node
 */

/**
 * #1169 residual — the org could not see what it owed.
 *
 * `ORG_RECEIVABLE` has been a real account per org since #771: a sponsored
 * booking debits it, an invoice payment credits it back, and a wallet debit
 * that could not be covered accrues the shortfall into it. None of it reached
 * the organization's own billing page, so a charge that had not yet been rolled
 * into an invoice was invisible to the people responsible for paying it.
 *
 * `getOrgReceivables` is that read. What these tests pin is the part a UI
 * cannot: that the totals come from the whole account rather than the page of
 * rows shown, that direction is what decides accrued from cleared, that a
 * posting is tied back to its booking through the payment the transaction
 * soft-links, and that the payload crosses the RSC boundary as plain JSON with
 * no bigint and no Date left in it.
 */

const mockLedgerAccountFindUnique = jest.fn();
const mockLedgerEntryGroupBy = jest.fn();
const mockLedgerEntryCount = jest.fn();
const mockLedgerEntryFindMany = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockInvoiceFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    // Array-form $transaction: the read model takes its three account reads
    // from one snapshot; the mock just runs the already-built promises.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    ledgerAccount: {
      findUnique: (...a: unknown[]) => mockLedgerAccountFindUnique(...a),
    },
    ledgerEntry: {
      groupBy: (...a: unknown[]) => mockLedgerEntryGroupBy(...a),
      count: (...a: unknown[]) => mockLedgerEntryCount(...a),
      findMany: (...a: unknown[]) => mockLedgerEntryFindMany(...a),
    },
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    organizationInvoice: {
      findMany: (...a: unknown[]) => mockInvoiceFindMany(...a),
    },
  },
}));

import {
  getOrgReceivables,
  ORG_RECEIVABLES_PAGE_SIZE,
} from "@/lib/data/org-receivables";
import { ORG_CLAWBACK_KEY_FILTER } from "@/lib/payments/payouts/clawback-recovery";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccruedUsagePanel } from "@/app/dashboard/organization/[orgId]/billing/AccruedUsagePanel";

const ORG = "org-1";
/** The deterministic account id `ledgerAccountId` derives for this org. */
const ACCOUNT_ID = `ORG_RECEIVABLE|${ORG}|_|INR`;

function entry(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "entry-1",
    direction: "DEBIT",
    amountPaise: BigInt(250_000),
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    transaction: {
      kind: "BOOKING",
      description: "Sponsored booking",
      paymentId: "pay-1",
      invoiceId: null,
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLedgerAccountFindUnique.mockResolvedValue({ id: ACCOUNT_ID });
  mockLedgerEntryGroupBy.mockResolvedValue([]);
  mockLedgerEntryCount.mockResolvedValue(0);
  mockLedgerEntryFindMany.mockResolvedValue([]);
  mockPaymentFindMany.mockResolvedValue([]);
  mockInvoiceFindMany.mockResolvedValue([]);
});

describe("an org that has never accrued", () => {
  it("returns an empty payload without touching the journal", async () => {
    mockLedgerAccountFindUnique.mockResolvedValue(null);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result).toEqual({
      hasAccount: false,
      accruedPaise: 0,
      clearedPaise: 0,
      outstandingPaise: 0,
      postings: [],
      totalPostings: 0,
    });
    expect(mockLedgerEntryFindMany).not.toHaveBeenCalled();
    expect(mockLedgerEntryGroupBy).not.toHaveBeenCalled();
  });

  it("resolves the account by its deterministic id, not by scope", async () => {
    mockLedgerAccountFindUnique.mockResolvedValue(null);

    await getOrgReceivables(ORG, "OWNER");

    expect(mockLedgerAccountFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ACCOUNT_ID } }),
    );
  });
});

describe("the totals describe the account, not the page", () => {
  it("nets debits against credits across every posting", async () => {
    mockLedgerEntryGroupBy.mockResolvedValue([
      { direction: "DEBIT", _sum: { amountPaise: BigInt(900_000) } },
      { direction: "CREDIT", _sum: { amountPaise: BigInt(350_000) } },
    ]);
    // Far more postings than the page shows — the totals must not be a sum
    // over the rows returned.
    mockLedgerEntryCount.mockResolvedValue(412);
    mockLedgerEntryFindMany.mockResolvedValue([entry()]);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.accruedPaise).toBe(900_000);
    expect(result.clearedPaise).toBe(350_000);
    expect(result.outstandingPaise).toBe(550_000);
    expect(result.totalPostings).toBe(412);
    expect(result.postings).toHaveLength(1);
  });

  it("reads zero for a direction that has never been posted", async () => {
    mockLedgerEntryGroupBy.mockResolvedValue([
      { direction: "DEBIT", _sum: { amountPaise: BigInt(120_000) } },
    ]);
    mockLedgerEntryCount.mockResolvedValue(1);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.clearedPaise).toBe(0);
    expect(result.outstandingPaise).toBe(120_000);
  });

  it("asks for the newest postings, capped at the page size", async () => {
    await getOrgReceivables(ORG, "OWNER");

    expect(mockLedgerEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: ACCOUNT_ID,
          transaction: { NOT: ORG_CLAWBACK_KEY_FILTER },
        },
        orderBy: { createdAt: "desc" },
        take: ORG_RECEIVABLES_PAGE_SIZE,
      }),
    );
  });

  it("honours a caller-supplied limit", async () => {
    await getOrgReceivables(ORG, "OWNER", 5);

    expect(mockLedgerEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });
});

describe("a posting says which way it moved and where it came from", () => {
  it("reads a DEBIT as accrued and a CREDIT as cleared", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      entry({ id: "e-debit", direction: "DEBIT" }),
      entry({
        id: "e-credit",
        direction: "CREDIT",
        transaction: {
          kind: "INVOICE_PAID",
          description: "Invoice settled",
          paymentId: null,
          invoiceId: "inv-1",
        },
      }),
    ]);
    mockInvoiceFindMany.mockResolvedValue([{ id: "inv-1", status: "PAID" }]);
    mockPaymentFindMany.mockResolvedValue([
      { id: "pay-1", appointmentId: "appt-1" },
    ]);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.postings[0]).toEqual(
      expect.objectContaining({
        entryId: "e-debit",
        movement: "ACCRUED",
        kind: "BOOKING",
        paymentId: "pay-1",
        appointmentId: "appt-1",
        invoiceId: null,
        invoiceStatus: null,
      }),
    );
    expect(result.postings[1]).toEqual(
      expect.objectContaining({
        entryId: "e-credit",
        movement: "CLEARED",
        kind: "INVOICE_PAID",
        paymentId: null,
        appointmentId: null,
        invoiceId: "inv-1",
        invoiceStatus: "PAID",
      }),
    );
  });

  it("ties a posting back to its booking through the payment", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      entry({ id: "a", transaction: { ...entry().transaction } }),
      entry({
        id: "b",
        transaction: {
          kind: "BOOKING",
          description: null,
          paymentId: "pay-2",
          invoiceId: null,
        },
      }),
      // Same payment as the first — the id list must dedupe.
      entry({ id: "c" }),
    ]);
    mockPaymentFindMany.mockResolvedValue([
      { id: "pay-1", appointmentId: "appt-1" },
      { id: "pay-2", appointmentId: "appt-2" },
    ]);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.postings.map((p) => p.appointmentId)).toEqual([
      "appt-1",
      "appt-2",
      "appt-1",
    ]);
    expect(mockPaymentFindMany.mock.calls[0][0].where.id.in).toEqual([
      "pay-1",
      "pay-2",
    ]);
  });

  it("survives a payment whose booking has gone", async () => {
    // A soft-link is not a foreign key; the row it names may not be there.
    mockLedgerEntryFindMany.mockResolvedValue([entry()]);
    mockPaymentFindMany.mockResolvedValue([]);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.postings[0].paymentId).toBe("pay-1");
    expect(result.postings[0].appointmentId).toBeNull();
  });

  it("never reads another org's invoice for a status", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      entry({
        transaction: {
          kind: "INVOICE_ISSUED",
          description: null,
          paymentId: null,
          invoiceId: "inv-9",
        },
      }),
    ]);

    await getOrgReceivables(ORG, "OWNER");

    expect(mockInvoiceFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ["inv-9"] },
      organizationId: ORG,
    });
  });

  it("skips the follow-up reads when nothing is soft-linked", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      entry({
        transaction: {
          kind: "BOOKING",
          description: null,
          paymentId: null,
          invoiceId: null,
        },
      }),
    ]);

    await getOrgReceivables(ORG, "OWNER");

    expect(mockPaymentFindMany).not.toHaveBeenCalled();
    expect(mockInvoiceFindMany).not.toHaveBeenCalled();
  });
});

describe("a booking charge reads its invoice from the payment, as the summary does", () => {
  // The billing summary counts a payment as "not yet invoiced" while it is
  // SUCCEEDED with no billableToOrgInvoiceId; a booking posting never carries
  // an invoice id of its own, so the row must read the same payment field.
  it("names the invoice a billed booking is on, even a void one", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([entry()]);
    mockPaymentFindMany.mockResolvedValue([
      {
        id: "pay-1",
        appointmentId: "appt-1",
        paymentStatus: "SUCCEEDED",
        billableToOrgInvoiceId: "inv-4",
      },
    ]);
    mockInvoiceFindMany.mockResolvedValue([
      { id: "inv-4", status: "VOID", invoiceNumber: "WIPRO-2026-0004" },
    ]);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.postings[0]).toEqual(
      expect.objectContaining({
        invoiceId: "inv-4",
        invoiceNumber: "WIPRO-2026-0004",
        invoiceStatus: "VOID",
        awaitingInvoice: false,
      }),
    );
    const html = renderToStaticMarkup(
      createElement(AccruedUsagePanel, { receivables: result }),
    );
    expect(html).toContain("WIPRO-2026-0004 · Void");
    expect(html).not.toContain("Not yet invoiced");
    // The Outstanding tile sums ISSUED and OVERDUE invoices, due date or not.
    expect(html).toContain(
      "Outstanding above counts only issued invoices not yet paid, including those not yet due.",
    );
  });

  it.each([
    ["OWNER", "WIPRO-2026-0001 · Draft", "inv-1"],
    ["MANAGER", "On an invoice not yet issued", null],
  ] as const)(
    "shows a booking's draft invoice to a %s as %s",
    async (role, cell, invoiceId) => {
      mockLedgerEntryFindMany.mockResolvedValue([entry()]);
      mockPaymentFindMany.mockResolvedValue([
        {
          id: "pay-1",
          appointmentId: null,
          paymentStatus: "SUCCEEDED",
          billableToOrgInvoiceId: "inv-1",
        },
      ]);
      mockInvoiceFindMany.mockResolvedValue([
        { id: "inv-1", status: "DRAFT", invoiceNumber: "WIPRO-2026-0001" },
      ]);

      const result = await getOrgReceivables(ORG, role);
      const html = renderToStaticMarkup(
        createElement(AccruedUsagePanel, { receivables: result }),
      );

      expect(html).toContain(cell);
      expect(result.postings[0].awaitingInvoice).toBe(false);
      // A non-manager's page payload carries neither the draft's id nor number.
      expect(result.postings[0].invoiceId).toBe(invoiceId);
      expect(JSON.stringify(result).includes("WIPRO-2026-0001")).toBe(
        invoiceId !== null,
      );
    },
  );

  it("says not yet invoiced only for a succeeded payment on no invoice", async () => {
    mockLedgerEntryFindMany.mockResolvedValue([
      entry({ id: "unbilled" }),
      entry({
        id: "refunded",
        transaction: { ...entry().transaction, paymentId: "pay-2" },
      }),
    ]);
    mockPaymentFindMany.mockResolvedValue([
      {
        id: "pay-1",
        appointmentId: null,
        paymentStatus: "SUCCEEDED",
        billableToOrgInvoiceId: null,
      },
      {
        id: "pay-2",
        appointmentId: null,
        paymentStatus: "REFUNDED",
        billableToOrgInvoiceId: null,
      },
    ]);

    const result = await getOrgReceivables(ORG, "OWNER");

    expect(result.postings.map((p) => p.awaitingInvoice)).toEqual([
      true,
      false,
    ]);
    expect(mockInvoiceFindMany).not.toHaveBeenCalled();
  });
});

describe("the payload crosses the RSC boundary", () => {
  it("carries no bigint and no Date", async () => {
    mockLedgerEntryGroupBy.mockResolvedValue([
      { direction: "DEBIT", _sum: { amountPaise: BigInt(777) } },
    ]);
    mockLedgerEntryCount.mockResolvedValue(1);
    mockLedgerEntryFindMany.mockResolvedValue([entry()]);
    mockPaymentFindMany.mockResolvedValue([
      { id: "pay-1", appointmentId: "appt-1" },
    ]);

    const result = await getOrgReceivables(ORG, "OWNER");

    // Would throw on a bigint and would silently stringify a Date; the
    // round-trip proves neither is in there.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(typeof result.postings[0].amountPaise).toBe("number");
    expect(result.postings[0].postedAt).toBe("2026-08-01T10:00:00.000Z");
  });
});
