/**
 * GET  /api/organizations/[orgId]/billing-account/invoices
 * POST /api/organizations/[orgId]/billing-account/invoices
 *
 * POST manually generates an invoice (vs the daily cron at
 * jobs/billing/generate-subscription-invoices.ts which auto-generates
 * from BillingSubscription.nextInvoiceDate). Useful for one-off line
 * items or for re-issuing a voided invoice. Platform ops raise the same
 * invoice through the audited POST /api/admin/organizations/[orgId]/invoices.
 *
 * Every invoice carries its GST breakdown + IRN placeholder. The IRN
 * stays PENDING until the IRP uploader cron (stubbed) populates it.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  createOrgInvoice,
  CreateOrgInvoiceSchema,
  notifyCreatedOrgInvoice,
} from "@/lib/payments/billing/create-org-invoice";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";

const InvoiceStatusSchema = z.enum([
  "DRAFT",
  "ISSUED",
  "PAID",
  "OVERDUE",
  "VOID",
  "CANCELLED",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus ? InvoiceStatusSchema.safeParse(rawStatus) : null;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 20)),
  );

  const where = {
    organizationId: orgId,
    ...(status?.success ? { status: status.data } : {}),
  };

  const [total, invoices] = await prisma.$transaction([
    prisma.organizationInvoice.count({ where }),
    prisma.organizationInvoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        purchaseOrder: { select: { id: true, poNumber: true } },
      },
    }),
  ]);

  return NextResponse.json({ data: invoices, meta: { total, page, perPage } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "billing.manage",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  // Invoice generation is a statutory-document write.
  const limited = await applyRateLimit(
    moneyOpsLimiter,
    access.member?.id ?? orgId,
  );
  if (limited) return limited;

  const raw = await req.json().catch(() => null);
  const parsed = CreateOrgInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  let created;
  try {
    created = await prisma.$transaction((tx) =>
      createOrgInvoice(tx, {
        orgId,
        actorMembershipId: access.member.id,
        input: body,
      }),
    );
  } catch (err) {
    if (err instanceof OpsRefusal) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }

  notifyCreatedOrgInvoice(new URL(req.url).origin, orgId, created, body);
  return NextResponse.json({ invoice: created.invoice }, { status: 201 });
}
