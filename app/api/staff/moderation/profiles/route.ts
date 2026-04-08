/**
 * Staff Moderation Profile Verification API
 * List pending consultant profile verifications
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ProfileVerificationStatus, Prisma } from "@prisma/client";
import type { ProfileVerification } from "@/types/moderation";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
/**
 * GET /api/staff/moderation/profiles
 * List pending profile verifications
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { searchParams } = new URL(req.url);
    const status = searchParams.get(
      "status",
    ) as ProfileVerificationStatus | null;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    const where: Prisma.ConsultantProfileVerificationWhereInput = {};
    if (status) where.status = status;

    const [verifications, total] = await Promise.all([
      prisma.consultantProfileVerification.findMany({
        where,
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
                  bio: true,
                },
              },
              domain: { select: { id: true, name: true } },
              subDomains: { select: { id: true, name: true } },
            },
          },
          documents: true,
        },
        orderBy: [
          { status: "asc" }, // Pending first
          { submittedAt: "asc" }, // Oldest first
        ],
        take: limit,
        skip: offset,
      }),
      prisma.consultantProfileVerification.count({ where }),
    ]);

    // Filter out verifications with missing profile data (defensive)
    const validVerifications = verifications.filter(
      (v) => v.consultantProfile && v.consultantProfile.user,
    );

    const formattedVerifications: ProfileVerification[] =
      validVerifications.map((v) => ({
        id: v.id,
        status: v.status,
        submittedAt: v.submittedAt.toISOString(),
        notes: v.notes,
        rejectionReason: v.rejectionReason,
        feedbackDetails: v.feedbackDetails,
        // Flatten consultantProfile + user into the "consultant" shape the frontend expects
        consultant: {
          profileId: v.consultantProfile.id,
          userId: v.consultantProfile.user.id,
          name: v.consultantProfile.user.name,
          email: v.consultantProfile.user.email,
          image: v.consultantProfile.user.image,
          linkedinUrl: v.consultantProfile.user.linkedinUrl,
          domain: v.consultantProfile.domain?.name ?? "",
          experience: v.consultantProfile.experience,
          headline: v.consultantProfile.headline,
          isVerified: v.status === "APPROVED",
          verificationStatus: v.status,
        },
        documents: v.documents.map((d) => ({
          id: d.id,
          fileName: d.fileName,
          originalName: d.originalName,
          fileSize: d.fileSize,
          mimeType: d.mimeType,
          fileUrl: d.fileUrl,
          description: d.description,
        })),
        reviewedAt: v.reviewedAt?.toISOString() ?? null,
        reviewedById: v.reviewedById,
        reviewNotes: v.reviewNotes,
      }));

    // Get counts by status
    const statusCounts = await prisma.consultantProfileVerification.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    const counts = {
      total,
      pending: statusCounts.find((s) => s.status === "PENDING")?._count.id || 0,
      approved:
        statusCounts.find((s) => s.status === "APPROVED")?._count.id || 0,
      rejected:
        statusCounts.find((s) => s.status === "REJECTED")?._count.id || 0,
      needsInfo:
        statusCounts.find((s) => s.status === "NEEDS_INFO")?._count.id || 0,
    };

    return NextResponse.json({
      verifications: formattedVerifications,
      counts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching profile verifications:", error);
    return NextResponse.json(
      { error: "Failed to fetch verifications" },
      { status: 500 },
    );
  }
}
