/**
 * Shared operator profile-verification queue.
 *
 * Used by both `app/api/admin/verification/route.ts` and
 * `app/api/staff/moderation/profiles/route.ts` — same resource (consultant
 * profile verifications) exposed under two URLs for the admin and staff
 * dashboards. The previously-duplicated query+formatting now lives here.
 *
 * The result shape matches the `ProfileVerification` type the frontend's
 * shared `VerificationQueue` component already consumes (it accepts an
 * `apiBasePath` prop and is mounted on both dashboards).
 */

import prisma from "@/lib/prisma";
import { ProfileVerificationStatus, Prisma } from "@prisma/client";
import type { ProfileVerification } from "@/types/moderation";

export type OperatorVerificationFilters = {
  status?: ProfileVerificationStatus | null;
  page?: number;
  limit?: number;
};

export type OperatorVerificationCounts = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  needsInfo: number;
};

export type OperatorVerificationResult = {
  verifications: ProfileVerification[];
  counts: OperatorVerificationCounts;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
};

/**
 * Fetch the profile verification queue for admin/staff dashboards.
 *
 * Single source of truth — call from any privileged-role route after running
 * `requirePrivilegedAuth()`.
 */
export async function getVerificationQueue(
  filters: OperatorVerificationFilters = {},
): Promise<OperatorVerificationResult> {
  const status = filters.status ?? null;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;
  const offset = (page - 1) * limit;

  const where: Prisma.ConsultantProfileVerificationWhereInput = {};
  if (status) where.status = status;

  const [verifications, total, statusCounts] = await Promise.all([
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
    prisma.consultantProfileVerification.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
  ]);

  // Filter out verifications with missing profile data (defensive)
  const validVerifications = verifications.filter(
    (v) => v.consultantProfile && v.consultantProfile.user,
  );

  const formattedVerifications: ProfileVerification[] = validVerifications.map(
    (v) => ({
      id: v.id,
      status: v.status,
      submittedAt: v.submittedAt.toISOString(),
      notes: v.notes,
      rejectionReason: v.rejectionReason,
      feedbackDetails: v.feedbackDetails,
      // Flatten consultantProfile + user into the "consultant" shape the
      // frontend expects.
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
    }),
  );

  const counts: OperatorVerificationCounts = {
    total,
    pending: statusCounts.find((s) => s.status === "PENDING")?._count.id || 0,
    approved: statusCounts.find((s) => s.status === "APPROVED")?._count.id || 0,
    rejected: statusCounts.find((s) => s.status === "REJECTED")?._count.id || 0,
    needsInfo:
      statusCounts.find((s) => s.status === "NEEDS_INFO")?._count.id || 0,
  };

  return {
    verifications: formattedVerifications,
    counts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + limit < total,
    },
  };
}
