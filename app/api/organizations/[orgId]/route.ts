/**
 * GET    /api/organizations/[orgId]
 * PATCH  /api/organizations/[orgId]
 * DELETE /api/organizations/[orgId]
 *
 * Core org-record CRUD. GET returns the full merged shape the dashboard
 * Home uses (capabilities, billing account summary, hosting-side summary,
 * counts). PATCH accepts a narrow set of owner-editable fields and guards
 * capability flips so we never end up with canSponsor=false && canHost=false.
 * DELETE is owner-only AND only for orgs with no active contracts/invoices
 * — otherwise admins must DEACTIVATE via the admin-verify endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const SizeBucketSchema = z.enum([
  "SMALL_1_50",
  "MEDIUM_51_200",
  "LARGE_201_1000",
  "ENTERPRISE_1000_PLUS",
]);
const GstRegStatusSchema = z.enum(["REGULAR", "COMPOSITION", "UNREGISTERED"]);

const PatchBodySchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    website: z.string().url().nullable().optional(),
    sizeBucket: SizeBucketSchema.nullable().optional(),
    logo: z.string().url().nullable().optional(),
    bannerImage: z.string().url().nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
      .nullable()
      .optional(),
    secondaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
      .nullable()
      .optional(),
    billingEmail: z.string().email().optional(),
    canSponsor: z.boolean().optional(),
    canHost: z.boolean().optional(),
    requiresPO: z.boolean().optional(),
    paymentTermsDays: z.coerce.number().int().min(0).max(180).optional(),
    gstin: z.string().length(15).nullable().optional(),
    pan: z.string().length(10).nullable().optional(),
    gstRegStatus: GstRegStatusSchema.optional(),
    gstStateCode: z.string().length(2).nullable().optional(),
    defaultCancellationPolicy: z.string().max(5000).nullable().optional(),
    defaultRefundPolicy: z.string().max(5000).nullable().optional(),
    enforceOrganizationPlans: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "LEARNER");
  if (access.error) return access.error;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: {
      billingAccount: {
        select: {
          id: true,
          fundingSource: true,
          currency: true,
          walletBalance: true,
          creditLimit: true,
        },
      },
      payoutAccount: {
        select: {
          id: true,
          status: true,
          accountNumberLast4: true,
          bankName: true,
        },
      },
      _count: {
        select: {
          memberships: true,
          contracts: true,
          invoices: true,
          purchaseOrders: true,
          auditLogs: true,
        },
      },
    },
  });
  if (!org) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    organization: org,
    membership: { role: access.member.role, status: access.member.status },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
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
      const current = await tx.organization.findUnique({
        where: { id: orgId },
        include: { billingAccount: { select: { id: true, walletBalance: true } } },
      });
      if (!current) {
        throw Object.assign(new Error("Organization not found"), {
          httpStatus: 404,
        });
      }

      const nextCanSponsor = body.canSponsor ?? current.canSponsor;
      const nextCanHost = body.canHost ?? current.canHost;
      if (!nextCanSponsor && !nextCanHost) {
        throw Object.assign(
          new Error(
            "Cannot disable both capabilities — at least one of canSponsor/canHost must remain true.",
          ),
          { httpStatus: 409 },
        );
      }

      // Turning canSponsor OFF with a non-zero wallet would orphan the
      // money. The owner must drain or refund the wallet first.
      if (
        body.canSponsor === false &&
        (current.billingAccount?.walletBalance ?? 0) > 0
      ) {
        throw Object.assign(
          new Error(
            "Cannot disable canSponsor while wallet has a non-zero balance",
          ),
          { httpStatus: 409 },
        );
      }

      const next = await tx.organization.update({
        where: { id: orgId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.industry !== undefined && { industry: body.industry }),
          ...(body.website !== undefined && { website: body.website }),
          ...(body.sizeBucket !== undefined && { sizeBucket: body.sizeBucket }),
          ...(body.logo !== undefined && { logo: body.logo }),
          ...(body.bannerImage !== undefined && { bannerImage: body.bannerImage }),
          ...(body.primaryColor !== undefined && { primaryColor: body.primaryColor }),
          ...(body.secondaryColor !== undefined && { secondaryColor: body.secondaryColor }),
          ...(body.billingEmail !== undefined && { billingEmail: body.billingEmail }),
          ...(body.canSponsor !== undefined && { canSponsor: body.canSponsor }),
          ...(body.canHost !== undefined && { canHost: body.canHost }),
          ...(body.requiresPO !== undefined && { requiresPO: body.requiresPO }),
          ...(body.paymentTermsDays !== undefined && {
            paymentTermsDays: body.paymentTermsDays,
          }),
          ...(body.gstin !== undefined && { gstin: body.gstin }),
          ...(body.pan !== undefined && { pan: body.pan }),
          ...(body.gstRegStatus !== undefined && { gstRegStatus: body.gstRegStatus }),
          ...(body.gstStateCode !== undefined && { gstStateCode: body.gstStateCode }),
          ...(body.defaultCancellationPolicy !== undefined && {
            defaultCancellationPolicy: body.defaultCancellationPolicy,
          }),
          ...(body.defaultRefundPolicy !== undefined && {
            defaultRefundPolicy: body.defaultRefundPolicy,
          }),
          ...(body.enforceOrganizationPlans !== undefined && {
            enforceOrganizationPlans: body.enforceOrganizationPlans,
          }),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
          description: "Organization record updated",
          details: { patch: body },
        },
      });

      return next;
    });

    return NextResponse.json({ organization: updated });
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
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
        where: { id: orgId },
        include: {
          _count: {
            select: {
              contracts: true,
              invoices: true,
              purchaseOrders: true,
              earnings: true,
            },
          },
        },
      });
      if (!current) {
        throw Object.assign(new Error("Organization not found"), {
          httpStatus: 404,
        });
      }

      const refs =
        current._count.contracts +
        current._count.invoices +
        current._count.purchaseOrders +
        current._count.earnings;
      if (refs > 0) {
        throw Object.assign(
          new Error(
            `Cannot delete an organization with contracts (${current._count.contracts}), invoices (${current._count.invoices}), POs (${current._count.purchaseOrders}), or earnings (${current._count.earnings}). Use the admin DEACTIVATE path instead.`,
          ),
          { httpStatus: 409 },
        );
      }

      await tx.organization.delete({ where: { id: orgId } });
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
