/**
 * Staff Moderation Profile Verification API
 * List pending consultant profile verifications
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, ProfileVerificationStatus } from "@prisma/client";

/**
 * GET /api/staff/moderation/profiles
 * List pending profile verifications
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as ProfileVerificationStatus | null;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};
    if (status) where.status = status;

    const [verifications, total] = await Promise.all([
      prisma.consultantProfileVerification.findMany({
        where,
        include: {
          consultantProfile: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
              domain: { select: { id: true, name: true } },
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

    const formattedVerifications = verifications.map((v) => ({
      id: v.id,
      status: v.status,
      submittedAt: v.submittedAt,
      notes: v.notes,
      consultant: {
        profileId: v.consultantProfile.id,
        userId: v.consultantProfile.user.id,
        name: v.consultantProfile.user.name,
        email: v.consultantProfile.user.email,
        image: v.consultantProfile.user.image,
        domain: v.consultantProfile.domain.name,
        experience: v.consultantProfile.experience,
        headline: v.consultantProfile.headline,
        isVerified: v.consultantProfile.isVerified,
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
      reviewedAt: v.reviewedAt,
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
      pending:
        statusCounts.find((s) => s.status === "PENDING")?._count.id || 0,
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
      { status: 500 }
    );
  }
}
