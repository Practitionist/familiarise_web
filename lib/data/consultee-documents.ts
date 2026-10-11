/**
 * Consultee documents reader: session handouts from booked plans plus
 * deliverable threads across personal bookings.
 */

import type { DocumentReviewStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  buildRootThreadStatusWhere,
  groupDocumentsIntoThreads,
} from "@/lib/documents/document-review";

const CLOSED_STATUSES = ["CANCELLED", "REJECTED", "EXPIRED"] as const;
const PAID_PARTICIPANT_STATUSES = ["CONFIRMED", "ATTENDED"] as const;

const CONSULTEE_DOCUMENTS_PAGE_SIZE = 20;
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
  appointmentStatus: string;
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

function normalizeDocumentsQuery(raw: {
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
          subscriptions: {
            some: { ...openRequest, appointment: { organizationId: null } },
          },
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

  const baseRootWhere: Prisma.AppointmentDocumentWhereInput = {
    deletedAt: null,
    rootDocumentId: null,
    appointment: ownBookingWhere(consulteeId),
  };
  const rootWhere = buildRootThreadStatusWhere(baseRootWhere, status);

  const [rootRows, totalCount, materials] = await Promise.all([
    prisma.appointmentDocument.findMany({
      where: rootWhere,
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
        threadVersions: {
          where: { deletedAt: null },
          orderBy: { versionNo: "asc" },
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
          },
        },
        appointment: {
          select: {
            consultation: {
              select: { status: true, consultationPlan: planSelect },
            },
            subscription: {
              select: { status: true, subscriptionPlan: planSelect },
            },
          },
        },
      },
      orderBy: { uploadedAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.appointmentDocument.count({ where: rootWhere }),
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

  const flattenedDocs: ConsulteeDocumentRow[] = rootRows.flatMap((rootDoc) => {
    const plan =
      rootDoc.appointment.consultation?.consultationPlan ??
      rootDoc.appointment.subscription?.subscriptionPlan ??
      null;
    const appointmentStatus =
      rootDoc.appointment.consultation?.status ??
      rootDoc.appointment.subscription?.status ??
      "UNKNOWN";
    const appointmentTitle = plan?.title ?? "Booking";
    const consultantName = plan?.consultantProfile.user.name ?? null;

    return [rootDoc, ...rootDoc.threadVersions].map((doc) => ({
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
      appointmentTitle,
      appointmentStatus,
      consultantName,
    }));
  });

  const pageThreads = groupDocumentsIntoThreads(flattenedDocs);
  const filteredThreads = status
    ? pageThreads.filter((thread) => thread.effectiveStatus === status)
    : pageThreads;
  const pageDocuments = filteredThreads.flatMap((thread) => thread.versions);

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
