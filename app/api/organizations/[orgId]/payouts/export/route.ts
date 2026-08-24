/**
 * GET /api/organizations/[orgId]/payouts/export
 *
 * CSV export of the org's payout history — mirrors the audit exporter's
 * streaming pattern (cursor pagination, bounded chunks) so a long-lived org
 * can't OOM the function. Wave-4 (#1230): finance teams reconciling against
 * bank statements previously had no machine-readable export on this surface.
 *
 * Column truth matches the wave-1 display fix: `disbursed_paise` is the
 * post-TDS cash (amountPaise), and tds/net are itemized separately so the
 * CSV reconciles against both the ledger and the bank.
 *
 * Self-auditing: emits PAYOUT_EXPORTED before streaming, same discipline as
 * AUDIT_LOG_EXPORTED.
 */

import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CSV_CHUNK_SIZE = 500;
const MAX_ITERATIONS = 400; // 400 × 500 = 200k rows ceiling

function csvEscape(v: string | number | null | undefined): string {
  if (v === "" || v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Hoisted so TS can type `rows` without the self-referential cursor loop.
const PAYOUT_EXPORT_SELECT = {
  id: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  currency: true,
  grossRevenuePaise: true,
  platformFeePaise: true,
  refundsPaise: true,
  tdsAmountPaise: true,
  netPayoutPaise: true,
  amountPaise: true,
  processedAt: true,
  createdAt: true,
} satisfies Prisma.OrganizationPayoutSelect;

// Runtime shape after the #780 BigInt→number result extension — do NOT use
// Prisma.OrganizationPayoutGetPayload here, whose paise fields are bigint.
type PayoutExportRow = {
  id: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  grossRevenuePaise: number;
  platformFeePaise: number;
  refundsPaise: number;
  tdsAmountPaise: number | null;
  netPayoutPaise: number;
  amountPaise: number;
  processedAt: Date | null;
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
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_EXPORTED,
      description: "Payout history exported to CSV",
    },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            "id,status,period_start,period_end,currency,gross_paise,platform_fee_paise,refunds_paise,tds_paise,net_pre_tds_paise,disbursed_paise,processed_at,created_at\n",
          ),
        );

        let cursor: { createdAt: Date; id: string } | null = null;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const rows: PayoutExportRow[] = await prisma.organizationPayout.findMany({
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
            select: PAYOUT_EXPORT_SELECT,
          });
          if (rows.length === 0) break;

          const lines = rows.map((r) =>
            [
              r.id,
              r.status,
              r.periodStart?.toISOString() ?? "",
              r.periodEnd?.toISOString() ?? "",
              r.currency,
              r.grossRevenuePaise.toString(),
              r.platformFeePaise.toString(),
              r.refundsPaise.toString(),
              r.tdsAmountPaise?.toString() ?? "",
              r.netPayoutPaise.toString(),
              r.amountPaise.toString(),
              r.processedAt?.toISOString() ?? "",
              r.createdAt.toISOString(),
            ]
              .map(csvEscape)
              .join(","),
          );
          controller.enqueue(encoder.encode(lines.join("\n") + "\n"));

          const last = rows[rows.length - 1];
          cursor = { createdAt: last.createdAt, id: last.id };
        }
        controller.close();
      } catch (err) {
        // Mid-stream errors can't change headers — surface in-band and close
        // so the browser doesn't hang on an open stream.
        controller.enqueue(
          encoder.encode(`\n# EXPORT ERROR: ${(err as Error).message}\n`),
        );
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payouts-${orgId}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
