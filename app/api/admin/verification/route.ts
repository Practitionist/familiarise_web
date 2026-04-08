/**
 * Admin Verification API
 * GET /api/admin/verification - List all pending verifications
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ProfileVerificationStatus } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") || "PENDING";

    const verifications = await prisma.consultantProfileVerification.findMany({
      where: {
        status: status as ProfileVerificationStatus,
      },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                linkedinUrl: true,
                workExperiences: true,
                certifications: true,
                education: true,
              },
            },
            domain: { select: { id: true, name: true } },
            subDomains: { select: { id: true, name: true } },
          },
        },
        documents: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({ verifications });
  } catch (error) {
    console.error("Error fetching verifications:", error);
    return NextResponse.json(
      { error: "Failed to fetch verifications" },
      { status: 500 },
    );
  }
}
