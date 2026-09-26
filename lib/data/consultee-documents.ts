/**
 * #1527 — the consultee's Documents page in one read: the plan materials of
 * the sessions they booked, plus every file on their own bookings (their
 * uploads and the expert's responses), paged like the consultant's documents
 * route. Personal pin (ADR 19): org-funded bookings live on the org side.
 *
 * Auth stays with the caller, which binds the session to `consulteeId`.
 */

import type { DocumentReviewStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";

/** DOC-1 (#694) — a closed booking's files are no longer served. */
const CLOSED_STATUSES = ["CANCELLED", "REJECTED", "EXPIRED"] as const;

export const CONSULTEE_DOCUMENTS_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MATERIALS_CAP = 200;

const REVIEW_STATUSES: readonly DocumentReviewStatus[] = [
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
];

export interface ConsulteeDocumentRow {
  id: string;
  appointmentId: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
  reviewStatus: DocumentReviewStatus;
  /** CONSULTEE = the learner's upload; CONSULTANT = the expert's response. */
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  uploadedAt: Date | string;
  appointmentTitle: string;
  consultantName: string | null;
}

export interface ConsulteeMaterialRow {
  id: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
  uploadedAt: Date | string;
  planTitle: string;
  consultantName: string | null;
}

export interface ConsulteeDocumentsPayload {
  data: ConsulteeDocumentRow[];
  count: number;
  pagination: {
    limit: number;
    offset: number;
    totalCount: number;
    totalPages: number;
    currentPage: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  materials: ConsulteeMaterialRow[];
}

export function normalizeDocumentsQuery(raw: {
  limit?: number;
  offset?: number;
  status?: string | null;
}) {
  const limit =
    Number.isFinite(raw.limit) && (raw.limit as number) >= 1
      ? Math.min(MAX_PAGE_SIZE, Math.trunc(raw.limit as number))
      : CONSULTEE_DOCUMENTS_PAGE_SIZE;
  const offset =
    Number.isFinite(raw.offset) && (raw.offset as number) >= 0
      ? Math.trunc(raw.offset as number)
      : 0;
  const status = REVIEW_STATUSES.includes(raw.status as DocumentReviewStatus)
    ? (raw.status as DocumentReviewStatus)
    : null;
  return { limit, offset, status };
}

/** The learner's own personal 1:1 bookings that are still open for files. */
function ownBookingWhere(consulteeId: string): Prisma.AppointmentWhereInput {
  return {
    organizationId: null,
    OR: [
      {
        consultation: {
          requestedById: consulteeId,
          status: { notIn: [...CLOSED_STATUSES] },
        },
      },
      {
        subscription: {
          requestedById: consulteeId,
          status: { notIn: [...CLOSED_STATUSES] },
        },
      },
    ],
  };
}

const planSelect = {
  select: {
    title: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

/**
 * Materials of the plans behind the learner's bookings — the same arms the
 * resources read uses: their 1:1 requests, trials and the group events they
 * hold a seat on. A withdrawn request keeps none.
 */
function materialsWhere(
  consulteeId: string,
  userId: string,
): Prisma.PlanMaterialWhereInput {
  const seat = {
    appointment: {
      organizationId: null,
      participants: { some: liveParticipant(userId) },
    },
  };
  const openRequest = {
    requestedById: consulteeId,
    status: { notIn: [...CLOSED_STATUSES, "PENDING" as const] },
    appointment: { is: { organizationId: null } },
  };
  return {
    OR: [
      { consultationPlan: { consultations: { some: openRequest } } },
      {
        subscriptionPlan: {
          OR: [
            {
              subscriptions: {
                some: { ...openRequest, appointment: { organizationId: null } },
              },
            },
            { trials: { some: { consulteeProfileId: consulteeId } } },
          ],
        },
      },
      { webinarPlan: { webinars: { some: seat } } },
      { classPlan: { classes: { some: seat } } },
    ],
  };
}

export async function readConsulteeDocuments(args: {
  consulteeId: string;
  userId: string;
  limit?: number;
  offset?: number;
  status?: string | null;
}): Promise<ConsulteeDocumentsPayload> {
  const { consulteeId, userId } = args;
  const { limit, offset, status } = normalizeDocumentsQuery(args);
  const where: Prisma.AppointmentDocumentWhereInput = {
    deletedAt: null,
    appointment: ownBookingWhere(consulteeId),
    ...(status && { reviewStatus: status }),
  };

  const [documents, totalCount, materials] = await Promise.all([
    prisma.appointmentDocument.findMany({
      where,
      select: {
        id: true,
        appointmentId: true,
        originalName: true,
        fileSize: true,
        mimeType: true,
        fileUrl: true,
        description: true,
        reviewStatus: true,
        uploadedByRole: true,
        uploadedAt: true,
        appointment: {
          select: {
            consultation: { select: { consultationPlan: planSelect } },
            subscription: { select: { subscriptionPlan: planSelect } },
          },
        },
      },
      orderBy: { uploadedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.appointmentDocument.count({ where }),
    // The status filter narrows the learner's own files only; materials have none.
    status
      ? Promise.resolve([])
      : prisma.planMaterial.findMany({
          where: materialsWhere(consulteeId, userId),
          select: {
            id: true,
            originalName: true,
            fileSize: true,
            mimeType: true,
            fileUrl: true,
            description: true,
            uploadedAt: true,
            consultationPlan: planSelect,
            subscriptionPlan: planSelect,
            webinarPlan: planSelect,
            classPlan: planSelect,
          },
          orderBy: [{ uploadedAt: "desc" }, { order: "asc" }],
          take: MATERIALS_CAP,
        }),
  ]);

  return {
    data: documents.map((doc) => {
      const plan =
        doc.appointment.consultation?.consultationPlan ??
        doc.appointment.subscription?.subscriptionPlan ??
        null;
      return {
        id: doc.id,
        appointmentId: doc.appointmentId,
        originalName: doc.originalName,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
        fileUrl: doc.fileUrl,
        description: doc.description,
        reviewStatus: doc.reviewStatus,
        uploadedByRole: doc.uploadedByRole,
        uploadedAt: doc.uploadedAt,
        appointmentTitle: plan?.title ?? "Booking",
        consultantName: plan?.consultantProfile.user.name ?? null,
      };
    }),
    count: totalCount,
    pagination: {
      limit,
      offset,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      currentPage: Math.floor(offset / limit) + 1,
      hasNextPage: offset + limit < totalCount,
      hasPrevPage: offset > 0,
    },
    materials: materials.map((m) => {
      const plan =
        m.consultationPlan ??
        m.subscriptionPlan ??
        m.webinarPlan ??
        m.classPlan;
      return {
        id: m.id,
        originalName: m.originalName,
        fileSize: m.fileSize,
        mimeType: m.mimeType,
        fileUrl: m.fileUrl,
        description: m.description,
        uploadedAt: m.uploadedAt,
        planTitle: plan?.title ?? "Plan",
        consultantName: plan?.consultantProfile?.user.name ?? null,
      };
    }),
  };
}
