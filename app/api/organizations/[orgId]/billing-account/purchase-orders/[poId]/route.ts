/**
 * GET    /api/organizations/[orgId]/billing-account/purchase-orders/[poId]
 * PATCH  /api/organizations/[orgId]/billing-account/purchase-orders/[poId]
 * DELETE /api/organizations/[orgId]/billing-account/purchase-orders/[poId]
 *
 * DELETE is narrow: only POs with no contracts and no invoices can be
 * hard-deleted. Otherwise mark CANCELLED via PATCH.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";

const PoStatusSchema = z.enum(["ACTIVE", "CLOSED", "CANCELLED"]);

const PatchBodySchema = z
  .object({
    status: PoStatusSchema.optional(),
    poDate: z.coerce.date().optional(),
    validUntil: z.coerce.date().nullable().optional(),
    totalAmountPaise: z.coerce.number().int().min(0).optional(),
    remainingAmountPaise: z.coerce.number().int().min(0).optional(),
    uploadedDocUrl: z.string().url().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; poId: string }>;
  },
) {
  const { orgId, poId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, organizationId: orgId },
    include: {
      contracts: {
        select: { id: true, status: true, effectiveFrom: true, effectiveTo: true },
      },
      invoices: {
        select: { id: true, invoiceNumber: true, status: true, totalPaise: true },
      },
    },
  });
  if (!po) {
    return NextResponse.json({ error: "PurchaseOrder not found" }, { status: 404 });
  }
  return NextResponse.json({ purchaseOrder: po });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; poId: string }>;
  },
) {
  const { orgId, poId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findFirst({
        where: { id: poId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("PurchaseOrder not found"), {
          httpStatus: 404,
        });
      }
      return tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          ...(body.status !== undefined && { status: body.status }),
          ...(body.poDate !== undefined && { poDate: body.poDate }),
          ...(body.validUntil !== undefined && { validUntil: body.validUntil }),
          ...(body.totalAmountPaise !== undefined && {
            totalAmountPaise: body.totalAmountPaise,
          }),
          ...(body.remainingAmountPaise !== undefined && {
            remainingAmountPaise: body.remainingAmountPaise,
          }),
          ...(body.uploadedDocUrl !== undefined && {
            uploadedDocUrl: body.uploadedDocUrl,
          }),
        },
      });
    });
    return NextResponse.json({ purchaseOrder: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; poId: string }>;
  },
) {
  const { orgId, poId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findFirst({
        where: { id: poId, organizationId: orgId },
        include: {
          _count: { select: { contracts: true, invoices: true } },
        },
      });
      if (!current) {
        throw Object.assign(new Error("PurchaseOrder not found"), {
          httpStatus: 404,
        });
      }
      if (current._count.contracts > 0 || current._count.invoices > 0) {
        throw Object.assign(
          new Error(
            "Cannot delete a PO referenced by contracts or invoices. Mark CANCELLED via PATCH instead.",
          ),
          { httpStatus: 409 },
        );
      }
      await tx.purchaseOrder.delete({ where: { id: poId } });
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
