/**
 * Shared list-documents query for the #674 / B1-hybrid scope split.
 * `AppointmentDocument` doesn't carry its own `organizationId`; it
 * inherits via the parent `Appointment.organizationId`.
 */

import prisma from "@/lib/prisma";
import type { DocumentReviewStatus, Prisma } from "@prisma/client";
import type { Scope } from "./parse";

export interface ListDocumentsParams {
  scope: Scope;
  userId: string;
  reviewStatus?: DocumentReviewStatus;
  page?: number;
  perPage?: number;
}

export interface ListDocumentsResult {
  items: Awaited<ReturnType<typeof prisma.appointmentDocument.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

function buildWhere(
  params: ListDocumentsParams,
): Prisma.AppointmentDocumentWhereInput {
  const base: Prisma.AppointmentDocumentWhereInput = {
    ...(params.reviewStatus && { reviewStatus: params.reviewStatus }),
  };
  if (params.scope.kind === "personal") {
    // Personal docs: docs whose parent Appointment is NOT org-tagged
    // AND the user is a participant on it. The OR clause mirrors
    // listAppointmentsScoped for participation.
    return {
      ...base,
      appointment: {
        organizationId: null,
        OR: [
          { consultation: { requestedBy: { userId: params.userId } } },
          { subscription: { requestedBy: { userId: params.userId } } },
          { trialSession: { consulteeProfile: { userId: params.userId } } },
        ],
      },
    };
  }
  if (params.scope.kind === "org") {
    return {
      ...base,
      appointment: { organizationId: params.scope.orgId },
    };
  }
  return base;
}

export async function listDocumentsScoped(
  params: ListDocumentsParams,
): Promise<ListDocumentsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  const [total, items] = await prisma.$transaction([
    prisma.appointmentDocument.count({ where }),
    prisma.appointmentDocument.findMany({
      where,
      include: {
        appointment: {
          select: {
            id: true,
            appointmentType: true,
            organizationId: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: { uploadedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
