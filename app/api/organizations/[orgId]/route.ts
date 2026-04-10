/**
 * Organization resource — GET / PATCH / DELETE by Organization.id.
 *
 *   GET    — active member (read)
 *   PATCH  — ORG_ADMIN (profile + branding + limited BetterAuth Organization fields)
 *   DELETE — ORG_OWNER (soft delete → status DEACTIVATED)
 *
 * Rate validation for PROVIDER orgs (platformCommissionRate + orgRetainRate +
 * consultantPayoutRate must sum to 1.0) runs only when ENABLE_PROVIDER_ORGS is
 * on AND the caller is actually editing those fields on a PROVIDER/HYBRID org.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { OrganizationBillingMode, OrgSizeBucket } from "@prisma/client";

const patchOrgSchema = z.object({
  // BetterAuth Organization fields
  name: z.string().trim().min(2).max(100).optional(),
  logo: z.string().url().nullable().optional(),

  // OrganizationProfile fields
  billingEmail: z.string().email().optional(),
  billingMode: z.nativeEnum(OrganizationBillingMode).optional(),
  description: z.string().max(2000).nullable().optional(),
  industry: z.string().max(100).nullable().optional(),
  sizeBucket: z.nativeEnum(OrgSizeBucket).nullable().optional(),
  website: z.string().url().nullable().optional(),
  bannerImage: z.string().url().nullable().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  defaultCancellationPolicy: z.string().max(5000).nullable().optional(),
  defaultRefundPolicy: z.string().max(5000).nullable().optional(),
  seatsTotal: z.number().int().positive().nullable().optional(),
  orgInvoiceCreditLimit: z.number().int().nonnegative().nullable().optional(),
  paymentTermsDays: z.number().int().min(1).max(120).optional(),

  // PROVIDER-only fields (feature-flagged)
  platformCommissionRate: z.number().min(0).max(1).optional(),
  orgRetainRate: z.number().min(0).max(1).optional(),
  consultantPayoutRate: z.number().min(0).max(1).optional(),
  autoApproveConsultants: z.boolean().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, logo: true, createdAt: true },
    });

    return NextResponse.json({
      organization,
      profile: access.org,
      membership: {
        role: access.member.role,
        status: access.member.status,
      },
    });
  } catch (error) {
    console.error("[API /organizations/[orgId] GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch organization" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = patchOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;

    // Guard billingMode mutation after first payment. The billing mode is
    // selected at org creation and should be immutable once real payments
    // exist — switching modes mid-stream would leave the ledger in an
    // inconsistent state (e.g., credit pool with TAG_ONLY, unbilled
    // payments after switching away from INVOICED_MONTHLY).
    if (
      data.billingMode !== undefined &&
      data.billingMode !== access.org.billingMode
    ) {
      const hasPayments = await prisma.payment.count({
        where: { organizationProfileId: access.org.id },
        take: 1,
      });
      if (hasPayments > 0) {
        return NextResponse.json(
          {
            error:
              "Billing mode cannot be changed after the first payment. Contact support for billing mode migration.",
          },
          { status: 400 },
        );
      }
    }

    // Rate-sum validation for PROVIDER orgs (FEATURE-FLAGGED).
    const ratesTouched =
      data.platformCommissionRate !== undefined ||
      data.orgRetainRate !== undefined ||
      data.consultantPayoutRate !== undefined;
    if (ratesTouched) {
      if (!ENABLE_PROVIDER_ORGS) {
        return NextResponse.json(
          {
            error:
              "Revenue split rates are only editable on PROVIDER organizations.",
            flag: "ENABLE_PROVIDER_ORGS",
          },
          { status: 501 },
        );
      }
      if (access.org.kind === "BUYER") {
        return NextResponse.json(
          { error: "BUYER orgs do not have a consultant payout split." },
          { status: 400 },
        );
      }
      const platform =
        data.platformCommissionRate ?? access.org.platformCommissionRate;
      const orgRetain = data.orgRetainRate ?? access.org.orgRetainRate;
      const consultant =
        data.consultantPayoutRate ?? access.org.consultantPayoutRate;
      const sum = platform + orgRetain + consultant;
      if (Math.abs(sum - 1) > 0.0001) {
        return NextResponse.json(
          {
            error: `Revenue rates must sum to 1.0 (got ${sum.toFixed(4)})`,
          },
          { status: 400 },
        );
      }
    }

    // Split the patch between BetterAuth Organization (name, logo) and
    // OrganizationProfile (everything else).
    const { name, logo, ...profileFields } = data;

    const [updatedOrg, updatedProfile] = await prisma.$transaction([
      prisma.organization.update({
        where: { id: orgId },
        data: {
          ...(name !== undefined && { name }),
          ...(logo !== undefined && { logo }),
        },
      }),
      prisma.organizationProfile.update({
        where: { id: access.org.id },
        data: {
          ...profileFields,
          ...(logo !== undefined && { logo }),
        },
      }),
    ]);

    return NextResponse.json({
      organization: {
        id: updatedOrg.id,
        name: updatedOrg.name,
        slug: updatedOrg.slug,
        logo: updatedOrg.logo,
      },
      profile: updatedProfile,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId] PATCH] error:", error);
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 },
    );
  }
}

/**
 * DELETE — soft delete via status=DEACTIVATED. We keep the Organization row
 * intact so payment history and audit trails don't dangle.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgOwner(orgId);
    if (access.error) return access.error;

    await prisma.organizationProfile.update({
      where: { id: access.org.id },
      data: { status: "DEACTIVATED" },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API /organizations/[orgId] DELETE] error:", error);
    return NextResponse.json(
      { error: "Failed to delete organization" },
      { status: 500 },
    );
  }
}
