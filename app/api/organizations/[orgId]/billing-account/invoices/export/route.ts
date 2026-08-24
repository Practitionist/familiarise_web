/**
 * GET /api/organizations/[orgId]/billing-account/invoices/export
 *
 * CSV export of the org's invoice register — wave-4b parity with the
 * payouts exporter (#1230): cursor-paginated streaming, RFC-4180-safe
 * notice rows, self-auditing. GST columns are itemized (IGST/CGST/SGST)
 * so finance can reconcile straight against GSTR-1.
 */

import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CSV_CHUNK_SIZE = 500;
const MAX_ITERATIONS = 400; // 400 × 500 = 200k rows ceiling
const INVOICE_EXPORT_COLUMNS = 14;

function csvEscape(v: string | number | null | undefined): string {
  if (v === "" || v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvNoticeRow(message: string): string {
  return (
    [csvEscape(message), ...new Array(INVOICE_EXPORT_COLUMNS - 1).fill("")].join(",") +
    "\n"
  );
}

const INVOICE_EXPORT_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  displayCurrency: true,
  subtotalPaise: true,
  igstPaise: true,
  cgstPaise: true,
  sgstPaise: true,
  totalPaise: true,
  issuedAt: true,
  dueDate: true,
  paidAt: true,
  purchaseOrderId: true,
  contractId: true,
  createdAt: true,
} satisfies Prisma.OrganizationInvoiceSelect;

// Runtime shape after the #780 BigInt→number result extension.
type InvoiceExportRow = {
  id: string;
  invoiceNumber: string;
  status: string;
  displayCurrency: string;
  subtotalPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  issuedAt: Date | null;
  dueDate: Date | null;
  paidAt: Date | null;
  purchaseOrderId: string | null;
  contractId: string | null;
  createdAt: Date;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_EXPORTED,
      description: "Invoice register exported to CSV",
    },
  });

  const encoder = new TextEncoder();
  let cursor: { createdAt: Date; id: string } | null = null;
  let iterations = 0;
  let headerSent = false;
  let truncated = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(
          encoder.encode(
            "invoice_number,status,currency,subtotal_paise,igst_paise,cgst_paise,sgst_paise,total_paise,issued_at,due_date,paid_at,purchase_order_id,contract_id,id\n",
          ),
        );
      }
      if (_req.signal.aborted || iterations >= MAX_ITERATIONS) {
        if (truncated) {
          controller.enqueue(
            encoder.encode(
              csvNoticeRow(
                "TRUNCATED: row limit reached — re-export with a narrower date range via the API.",
              ),
            ),
          );
        }
        controller.close();
        return;
      }
      iterations += 1;

      try {
        const rows: InvoiceExportRow[] = await prisma.organizationInvoice.findMany({
          where: cursor
            ? {
                organizationId: orgId,
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : { organizationId: orgId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: CSV_CHUNK_SIZE,
          select: INVOICE_EXPORT_SELECT,
        });
        if (rows.length === 0) {
          controller.close();
          return;
        }

        const lines = rows.map((r) =>
          [
            r.invoiceNumber,
            r.status,
            r.displayCurrency,
            r.subtotalPaise.toString(),
            r.igstPaise.toString(),
            r.cgstPaise.toString(),
            r.sgstPaise.toString(),
            r.totalPaise.toString(),
            r.issuedAt?.toISOString() ?? "",
            r.dueDate?.toISOString() ?? "",
            r.paidAt?.toISOString() ?? "",
            r.purchaseOrderId ?? "",
            r.contractId ?? "",
            r.id,
          ]
            .map(csvEscape)
            .join(","),
        );
        controller.enqueue(encoder.encode(lines.join("\n") + "\n"));

        const last = rows.at(-1);
        if (!last) {
          controller.close();
          return;
        }
        cursor = { createdAt: last.createdAt, id: last.id };
        if (iterations >= MAX_ITERATIONS && rows.length === CSV_CHUNK_SIZE) {
          truncated = true;
        }
      } catch (err) {
        controller.enqueue(encoder.encode(csvNoticeRow(`EXPORT ERROR: ${(err as Error).message}`)));
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoices-${orgId}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
