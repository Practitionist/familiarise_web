/**
 * @jest-environment node
 */

/**
 * Per-org sequential invoice numbering (CGST Rule 46). Covers the pure
 * helpers; concurrency is validated separately at the integration layer
 * because Jest doesn't expose a real Postgres for the
 * INSERT ... ON CONFLICT ... RETURNING pattern.
 */

import {
  indianFiscalYear,
  generateOrgInvoiceNumber,
} from "@/lib/payments/billing/invoice-numbering";

describe("indianFiscalYear", () => {
  it("April → start of next FY", () => {
    expect(indianFiscalYear(new Date("2026-04-01T00:00:00.000Z"))).toBe(2026);
  });

  it("March → previous FY", () => {
    expect(indianFiscalYear(new Date("2026-03-31T23:59:59.000Z"))).toBe(2025);
  });

  it("December (mid-year) → current FY", () => {
    expect(indianFiscalYear(new Date("2026-12-15T12:00:00.000Z"))).toBe(2026);
  });

  it("January → previous calendar year's FY", () => {
    expect(indianFiscalYear(new Date("2026-01-15T00:00:00.000Z"))).toBe(2025);
  });
});

describe("generateOrgInvoiceNumber", () => {
  function mockTx(allocations: number[]) {
    let i = 0;
    return {
      $queryRaw: jest.fn().mockImplementation(async () => {
        if (i >= allocations.length) {
          throw new Error("ran out of mock allocations");
        }
        return [{ allocated: allocations[i++] }];
      }),
    };
  }

  it("uses invoiceNumberPrefix when set", async () => {
    const tx = mockTx([42]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme-corp", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-2026-0042");
    expect(result.fiscalYear).toBe(2026);
    expect(result.seq).toBe(42);
  });

  it("falls back to slug (uppercased) when prefix is null", async () => {
    const tx = mockTx([1]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme-corp", invoiceNumberPrefix: null },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-CORP-2026-0001");
  });

  it("zero-pads seq to 4 digits", async () => {
    const tx = mockTx([7]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-2026-0007");
  });

  it("does NOT trim seq once it exceeds 4 digits (10000+)", async () => {
    const tx = mockTx([10000]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-2026-10000");
  });
});
