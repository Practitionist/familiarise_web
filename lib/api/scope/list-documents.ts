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
  // `orgMember` = ONE member's own rows within an org. It must never fall
  // through to the unfiltered `base` below: that arm is the `all` scope
  // (admin/staff), and reaching it with an orgMember scope would return the
  // whole platform. `resolveOrgScope` now downgrades a non-operator's
  // ?orgScope=<orgId> to this kind, so the fall-through is live, not latent.
  if (params.scope.kind === "orgMember") {
    return {
      ...base,
      appointment: {
        organizationId: params.scope.orgId,
        OR: [
          { consultation: { requestedBy: { userId: params.scope.userId } } },
          { subscription: { requestedBy: { userId: params.scope.userId } } },
          { trialSession: { consulteeProfile: { userId: params.scope.userId } } },
          {
            consultation: {
              consultationPlan: {
                consultantProfile: { userId: params.scope.userId },
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfile: { userId: params.scope.userId },
              },
            },
          },
          {
            webinar: {
              webinarPlan: { consultantProfile: { userId: params.scope.userId } },
            },
          },
          {
            class: {
              classPlan: { consultantProfile: { userId: params.scope.userId } },
            },
          },
        ],
      },
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
