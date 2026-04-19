/**
 * GET  /api/organizations/[orgId]/contracts
 * POST /api/organizations/[orgId]/contracts
 *
 * Contracts are the negotiated commercial relationship between an org
 * and Familiarise. Every Program hangs off a Contract; every Invoice
 * optionally references one for audit. Only OWNERs can create contracts
 * — creating one has budget implications and can't be unlocked by a
 * MAINTAINER without an explicit promotion.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const ContractStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "EXPIRED",
  "TERMINATED",
]);

const CreateBodySchema = z
  .object({
    billingAccountId: z.string().min(1),
    // PurchaseOrder is optional — India enterprise orgs have
    // requiresPO=true, but we surface the UX constraint at the org
    // level. Server-side we only enforce the FK shape.
    purchaseOrderId: z.string().min(1).nullable().optional(),
    // `effectiveFrom` defaults to now so a contract created via API
    // takes effect immediately unless the caller specifies otherwise.
    effectiveFrom: z.coerce.date().default(() => new Date()),
    effectiveTo: z.coerce.date().nullable().optional(),
    paymentTermsDays: z.coerce.number().int().min(1).max(120).default(60),
    autoRenew: z.coerce.boolean().default(false),
    terms: z.unknown().optional(),
    status: ContractStatusSchema.default("DRAFT"),
  })
  .refine(
    (v) => v.effectiveTo === null || v.effectiveTo === undefined
      ? true
      : v.effectiveTo.getTime() > v.effectiveFrom.getTime(),
    {
      message: "effectiveTo must be strictly after effectiveFrom",
      path: ["effectiveTo"],
    },
  );

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw
    ? ContractStatusSchema.safeParse(statusRaw)
    : null;

  const contracts = await prisma.contract.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    include: {
      billingAccount: {
        select: { id: true, fundingSource: true, currency: true },
      },
      purchaseOrder: {
        select: { id: true, poNumber: true, status: true },
      },
      programs: {
        select: { id: true, name: true, type: true, status: true },
      },
      _count: { select: { programs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: contracts });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "OWNER",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // BillingAccount ownership check — the caller can only link contracts
  // to a BillingAccount owned by the same org they're admin of. A stolen
  // BillingAccount id from another tenant is rejected here rather than
  // hitting a FK error later.
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { id: body.billingAccountId },
    select: { ownerOrgId: true, currency: true },
  });
  if (!billingAccount || billingAccount.ownerOrgId !== orgId) {
    return NextResponse.json(
      { error: "BillingAccount does not belong to this organization" },
      { status: 400 },
    );
  }

  if (body.purchaseOrderId) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: body.purchaseOrderId },
      select: { organizationId: true },
    });
    if (!po || po.organizationId !== orgId) {
      return NextResponse.json(
        { error: "PurchaseOrder does not belong to this organization" },
        { status: 400 },
      );
    }
  }

  const contract = await prisma.$transaction(async (tx) => {
    const created = await tx.contract.create({
      data: {
        organizationId: orgId,
        billingAccountId: body.billingAccountId,
        purchaseOrderId: body.purchaseOrderId ?? null,
        status: body.status,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        paymentTermsDays: body.paymentTermsDays,
        autoRenew: body.autoRenew,
        terms: body.terms === undefined ? null : JSON.parse(JSON.stringify(body.terms)),
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "CONTRACT",
        action: AUDIT_ACTIONS.CONTRACT.CONTRACT_CREATED,
        description: `Contract created, effective from ${body.effectiveFrom.toISOString()}`,
        details: {
          contractId: created.id,
          billingAccountId: body.billingAccountId,
          paymentTermsDays: body.paymentTermsDays,
        },
      },
    });
    return created;
  });

  return NextResponse.json({ contract }, { status: 201 });
}
