/**
 * Consultant Tax Info API
 * Manage PAN, GSTIN, and other tax-related info for consultants
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { z } from "zod";
import { encryptPAN } from "@/lib/payments/tax/pan-crypto";

const updateTaxInfoSchema = z.object({
  panNumber: z.string().length(10).optional(),
  gstin: z.string().length(15).optional(),
  country: z.string().length(2).optional(),
  // BLOCKER-0 resolution (#1230 / handoff): this nullable column is the
  // CANONICAL entity-type field — payout withholding reads it fail-closed
  // (null ⇒ no ₹5L exemption). Until a consultant declares it here, every
  // payout over-withholds rather than wrongly granting companies the
  // individual exemption.
  taxEntityType: z.enum(["INDIVIDUAL", "HUF", "PARTNERSHIP", "LLP", "COMPANY"]).optional(),
});

/**
 * GET /api/consultant/tax-info
 * Get the authenticated consultant's tax info
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: { taxInfo: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const taxInfo = consultantProfile.taxInfo;
    return NextResponse.json({
      hasTaxInfo: !!taxInfo,
      panMasked: taxInfo?.panLast4 ? `XXXXXX${taxInfo.panLast4}` : null,
      panVerified: taxInfo?.panVerified ?? false,
      gstin: taxInfo?.gstin ?? null,
      gstinVerified: taxInfo?.gstinVerified ?? false,
      country: taxInfo?.country ?? "IN",
      isIndianResident: taxInfo?.isIndianResident ?? true,
      taxEntityType: taxInfo?.taxEntityType ?? null,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Tax info GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch tax info" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/consultant/tax-info
 * Create or update the authenticated consultant's tax info
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const body = await req.json();
    const validated = updateTaxInfoSchema.parse(body);

    const isIndianResident = (validated.country || "IN") === "IN";

    // Encrypt PAN if provided
    let panFields:
      | { panEncrypted: Uint8Array<ArrayBuffer>; panLast4: string }
      | undefined;
    if (validated.panNumber) {
      const { encrypted, last4 } = encryptPAN(validated.panNumber);
      panFields = { panEncrypted: encrypted, panLast4: last4 };
    }

    const taxInfo = await prisma.consultantTaxInfo.upsert({
      where: { consultantProfileId: consultantProfile.id },
      create: {
        consultantProfileId: consultantProfile.id,
        panEncrypted: panFields?.panEncrypted ?? null,
        panLast4: panFields?.panLast4 ?? null,
        gstin: validated.gstin,
        country: validated.country || "IN",
        isIndianResident,
        ...(validated.taxEntityType !== undefined && {
          taxEntityType: validated.taxEntityType,
        }),
      },
      update: {
        ...(validated.panNumber !== undefined && {
          panEncrypted: panFields?.panEncrypted ?? null,
          panLast4: panFields?.panLast4 ?? null,
          panVerified: false, // Reset verification on change
        }),
        ...(validated.gstin !== undefined && {
          gstin: validated.gstin,
          gstinVerified: false,
        }),
        ...(validated.country !== undefined && {
          country: validated.country,
          isIndianResident,
        }),
        ...(validated.taxEntityType !== undefined && {
          taxEntityType: validated.taxEntityType,
        }),
      },
    });

    return NextResponse.json({
      message: "Tax info updated",
      panMasked: taxInfo.panLast4 ? `XXXXXX${taxInfo.panLast4}` : null,
      panVerified: taxInfo.panVerified,
      gstin: taxInfo.gstin,
      gstinVerified: taxInfo.gstinVerified,
      country: taxInfo.country,
      taxEntityType: taxInfo.taxEntityType ?? null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Tax info PUT error:", error);
    return NextResponse.json(
      { error: "Failed to update tax info" },
      { status: 500 },
    );
  }
}
