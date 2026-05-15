/**
 * Per-org invoice numbering — CGST Rule 46 sequential rule.
 *
 * Allocations are atomic per (organizationId, fiscalYear): an
 * INSERT … ON CONFLICT DO UPDATE … RETURNING pattern against the
 * `org_invoice_counters` table reserves the next `nextSeq` even under
 * concurrent invoice creation. The @@unique on (organizationId,
 * invoiceNumber) is the belt; this counter is the suspenders so the
 * belt never has to retry.
 *
 * Format: `<PREFIX>-<FY>-<SEQ>` where SEQ is a 4-digit zero-padded
 * monotonic integer. PREFIX falls back to Organization.slug when
 * Organization.invoiceNumberPrefix is null.
 *
 * Indian fiscal year runs April–March. An invoice issued in April 2026
 * lands in FY 2026; one issued in March 2026 lands in FY 2025.
 */

import type { Prisma } from "@prisma/client";

export function indianFiscalYear(d: Date): number {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // Jan=0, Apr=3
  return m >= 3 ? y : y - 1;
}

/**
 * Atomically reserve the next sequence number for (orgId, fiscalYear).
 * Caller must be inside a Prisma $transaction.
 */
export async function allocateOrgInvoiceSeq(
  tx: Prisma.TransactionClient,
  organizationId: string,
  fiscalYear: number,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ allocated: number }>>`
    INSERT INTO "org_invoice_counters" ("organizationId", "fiscalYear", "nextSeq", "updatedAt")
    VALUES (${organizationId}, ${fiscalYear}, 2, NOW())
    ON CONFLICT ("organizationId", "fiscalYear")
    DO UPDATE SET "nextSeq" = "org_invoice_counters"."nextSeq" + 1,
                  "updatedAt" = NOW()
    RETURNING ("nextSeq" - 1)::int AS "allocated"
  `;
  const row = rows[0];
  if (!row || typeof row.allocated !== "number") {
    throw new Error("allocateOrgInvoiceSeq: empty RETURNING — DB state inconsistent");
  }
  return row.allocated;
}

export interface OrgInvoiceNumberInput {
  id: string;
  slug: string;
  invoiceNumberPrefix: string | null;
}

export async function generateOrgInvoiceNumber(
  tx: Prisma.TransactionClient,
  org: OrgInvoiceNumberInput,
  issuedAt: Date,
): Promise<{ invoiceNumber: string; fiscalYear: number; seq: number }> {
  const fiscalYear = indianFiscalYear(issuedAt);
  const seq = await allocateOrgInvoiceSeq(tx, org.id, fiscalYear);
  const prefix = (org.invoiceNumberPrefix ?? org.slug).toUpperCase();
  const padded = seq.toString().padStart(4, "0");
  return {
    invoiceNumber: `${prefix}-${fiscalYear}-${padded}`,
    fiscalYear,
    seq,
  };
}
