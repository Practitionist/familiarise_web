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
import { groupDocumentsIntoThreads } from "@/lib/documents/document-review";

/** DOC-1 (#694) — a closed booking's files are no longer served. */
const CLOSED_STATUSES = ["CANCELLED", "REJECTED", "EXPIRED"] as const;
const PAID_PARTICIPANT_STATUSES = ["CONFIRMED", "ATTENDED"] as const;

export const CONSULTEE_DOCUMENTS_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MATERIALS_CAP = 200;

const REVIEW_STATUSES: ReadonlySet<DocumentReviewStatus> = new Set([
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
] as const);

export interface ConsulteeDocumentRow {
  id: string;
  appointmentId: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  description: string | null;
  reviewStatus: DocumentReviewStatus;
  reviewNotes: string | null;
  versionNo: number;
  rootDocumentId: string | null;
  responseToDocumentId: string | null;
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
  const status = REVIEW_STATUSES.has(raw.status as DocumentReviewStatus)
    ? (raw.status as DocumentReviewStatus)
    : null;
  return { limit, offset, status };
}

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
      {
        trial: {
          consulteeProfileId: consulteeId,
          status: { notIn: ["REJECTED", "CANCELLED"] },
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

function materialsWhere(
  consulteeId: string,
  userId: string,
): Prisma.PlanMaterialWhereInput {
  const paidSeat = {
    status: { not: "CANCELLED" as const },
    appointment: {
      organizationId: null,
      participants: {
        some: {
          userId,
          status: { in: [...PAID_PARTICIPANT_STATUSES] },
        },
      },
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
            {
              trials: {
                some: {
                  consulteeProfileId: consulteeId,
                  status: { in: ["SCHEDULED", "COMPLETED"] },
                },
              },
            },
          ],
        },
      },
      { webinarPlan: { webinars: { some: paidSeat } } },
      { classPlan: { classes: { some: paidSeat } } },
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
  };

  const [documents, materials] = await Promise.all([
    prisma.appointmentDocument.findMany({
      where,
      select: {
        id: true,
        appointmentId: true,
        originalName: true,
        fileSize: true,
        mimeType: true,
        description: true,
        reviewStatus: true,
        reviewNotes: true,
        versionNo: true,
        rootDocumentId: true,
        responseToDocumentId: true,
        uploadedByRole: true,
        uploadedAt: true,
        appointment: {
          select: {
            consultation: { select: { consultationPlan: planSelect } },
            subscription: { select: { subscriptionPlan: planSelect } },
            trial: { select: { subscriptionPlan: planSelect } },
          },
        },
      },
      orderBy: { uploadedAt: "desc" },
    }),
    status
      ? Promise.resolve([])
      : prisma.planMaterial.findMany({
          where: materialsWhere(consulteeId, userId),
          select: {
            id: true,
            originalName: true,
            fileSize: true,
            mimeType: true,
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

  const mappedDocuments: ConsulteeDocumentRow[] = documents.map((doc) => {
    const plan =
      doc.appointment.consultation?.consultationPlan ??
      doc.appointment.subscription?.subscriptionPlan ??
      doc.appointment.trial?.subscriptionPlan ??
      null;
    return {
      id: doc.id,
      appointmentId: doc.appointmentId,
      originalName: doc.originalName,
      fileSize: doc.fileSize,
      mimeType: doc.mimeType,
      description: doc.description,
      reviewStatus: doc.reviewStatus,
      reviewNotes: doc.reviewNotes,
      versionNo: doc.versionNo,
      rootDocumentId: doc.rootDocumentId,
      responseToDocumentId: doc.responseToDocumentId,
      uploadedByRole: doc.uploadedByRole,
      uploadedAt: doc.uploadedAt,
      appointmentTitle: plan?.title ?? "Booking",
      consultantName: plan?.consultantProfile.user.name ?? null,
    };
  });

  // Group into deliverable threads BEFORE applying thread status filtering and
  // page slicing so a multi-version thread is never split across pages.
  const allThreads = groupDocumentsIntoThreads(mappedDocuments);
  const matchingThreads = status
    ? allThreads.filter((thread) => thread.effectiveStatus === status)
    : allThreads;

  const totalCount = matchingThreads.length;
  const pageThreads = matchingThreads.slice(offset, offset + limit);
  const pageDocuments = pageThreads.flatMap((thread) => thread.versions);

  return {
    data: pageDocuments,
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
        description: m.description,
        uploadedAt: m.uploadedAt,
        planTitle: plan?.title ?? "Plan",
        consultantName: plan?.consultantProfile?.user.name ?? null,
      };
    }),
  };
}
