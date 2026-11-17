/**
 * Shared operator profile-verification queue, read by
 * `app/api/admin/verification/route.ts` for both back-office trees. The page
 * body is `verificationQueuePageSchema` (`lib/backoffice/people-list-schemas.ts`).
 */

import prisma from "@/lib/prisma";
import { ProfileVerificationStatus, Prisma } from "@prisma/client";
import type { PageParams } from "@/lib/backoffice/list-paging";
import type { VerificationItem } from "@/lib/backoffice/people-list-schemas";

export type OperatorVerificationFilters = {
  status: ProfileVerificationStatus;
  paging: PageParams;
};

type OperatorVerificationCounts = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  needsInfo: number;
};

export type OperatorVerificationResult = {
  verifications: VerificationItem[];
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
 * Single source of truth — call after the route's `users.verify` gate.
 */
export async function getVerificationQueue({
  status,
  paging: { page, limit, skip },
}: OperatorVerificationFilters): Promise<OperatorVerificationResult> {
  const where: Prisma.ConsultantProfileVerificationWhereInput = { status };

  const [verifications, total, statusCounts] = await Promise.all([
    prisma.consultantProfileVerification.findMany({
      relationLoadStrategy: "join",
      where,
      include: {
        consultantProfile: {
          select: {
            id: true,
            userId: true,
            description: true,
            experience: true,
            headline: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                linkedinUrl: true,
                bio: true,
                // Extended consultant professional background — rendered by
                // the admin/staff VerificationReviewModal. Keep aligned with
                // `verificationItemSchema` in `lib/backoffice/people-list-schemas.ts`.
                workExperiences: {
                  select: {
                    id: true,
                    company: true,
                    title: true,
                    startDate: true,
                    endDate: true,
                    isCurrent: true,
                  },
                  orderBy: { startDate: "desc" },
                },
                certifications: {
                  select: {
                    id: true,
                    name: true,
                    issuingOrganization: true,
                    issueDate: true,
                  },
                  orderBy: { issueDate: "desc" },
                },
                education: {
                  select: {
                    id: true,
                    institution: true,
                    degree: true,
                    fieldOfStudy: true,
                    startYear: true,
                    endYear: true,
                  },
                  orderBy: { startYear: "desc" },
                },
              },
            },
            domain: { select: { id: true, name: true } },
            subDomains: { select: { id: true, name: true } },
          },
        },
        // No fileUrl: a document opens through its ACL'd download route.
        documents: {
          select: {
            id: true,
            fileName: true,
            originalName: true,
            fileSize: true,
            mimeType: true,
            description: true,
          },
          orderBy: { id: "asc" },
        },
      },
      // Oldest submission first; the id breaks a tie so a page never repeats a row.
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: limit,
      skip,
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

  const formattedVerifications: VerificationItem[] = validVerifications.map(
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
        bio: v.consultantProfile.user.bio ?? null,
        domain: v.consultantProfile.domain?.name ?? "",
        subDomains: v.consultantProfile.subDomains.map((s) => ({
          id: s.id,
          name: s.name,
        })),
        experience: v.consultantProfile.experience,
        headline: v.consultantProfile.headline,
        description: v.consultantProfile.description ?? null,
        isVerified: v.status === "APPROVED",
        verificationStatus: v.status,
        // Map Prisma field names onto the shape the
        // `VerificationReviewModal` already consumes.
        workExperiences: v.consultantProfile.user.workExperiences.map((w) => ({
          id: w.id,
          company: w.company,
          title: w.title,
          startDate: w.startDate.toISOString(),
          endDate: w.endDate ? w.endDate.toISOString() : null,
          current: w.isCurrent,
        })),
        education: v.consultantProfile.user.education.map((e) => ({
          id: e.id,
          institution: e.institution,
          degree: e.degree,
          field: e.fieldOfStudy ?? "",
          startYear: e.startYear ?? 0,
          endYear: e.endYear ?? null,
        })),
        certifications: v.consultantProfile.user.certifications.map((c) => ({
          id: c.id,
          name: c.name,
          issuer: c.issuingOrganization,
          issueDate: c.issueDate.toISOString(),
        })),
      },
      documents: v.documents,
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
      hasMore: skip + limit < total,
    },
  };
}
