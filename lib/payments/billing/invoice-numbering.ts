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
  // #776 — the Indian FY (Apr–Mar) is reckoned in IST, not UTC. An invoice issued
  // just after midnight IST on Apr 1 (before 05:30 IST) is still Mar 31 in UTC;
  // computing the FY in UTC would file it under the previous FY and desync the
  // invoice number's FY from its IST issue date (CGST Rule 46 sequential breach).
  // Shift into IST (UTC+5:30) before extracting year/month.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth(); // Jan=0, Apr=3
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
  // ORM upsert (no raw SQL), same atomic pattern as allocateOrgCreditNoteSeq:
  // create seeds nextSeq=2 and allocates seq 1; the update path increments and we
  // return the pre-increment value (nextSeq-1). The increment is a single DB-level
  // op and the compound @@id/ON CONFLICT serialises concurrent allocations.
  const counter = await tx.orgInvoiceCounter.upsert({
    where: { organizationId_fiscalYear: { organizationId, fiscalYear } },
    create: { organizationId, fiscalYear, nextSeq: 2 },
    update: { nextSeq: { increment: 1 } },
    select: { nextSeq: true },
  });
  return counter.nextSeq - 1;
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
