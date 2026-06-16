/**
 * Shared list-appointments query for the personal-vs-org-scope split
 * (#674 / B1-hybrid). One query, two routes:
 *
 *   - `/api/appointments?orgScope=...` — personal endpoint (auth: any
 *     signed-in user; defaults `personal`).
 *   - `/api/organizations/[orgId]/appointments` — org-scoped endpoint
 *     (auth: MANAGER+ at the org; scope is forced to `org:<orgId>`).
 *
 * Both routes call `listAppointmentsScoped` with the resolved Scope
 * and the same filters. The shape returned is identical so the same
 * client table component can render either source.
 *
 * Auth is enforced UPSTREAM in each route handler (`requireOrgAccess`
 * for the org route, session presence for the personal route). This
 * function trusts its caller — pass it the resolved Scope only after
 * `resolveOrgScope` returned `ok`.
 */

import prisma from "@/lib/prisma";
import type { AppointmentsType, Prisma } from "@prisma/client";
import type { Scope } from "./parse";

export interface ListAppointmentsParams {
  scope: Scope;
  /** The session user's id. Used as the personal-scope filter root. */
  userId: string;
  /** Optional appointmentType filter (CONSULTATION/SUBSCRIPTION/...). */
  appointmentType?: AppointmentsType;
  /** Pagination — 1-indexed page, default 20 items per page. */
  page?: number;
  perPage?: number;
}

export interface ListAppointmentsResult {
  items: Awaited<ReturnType<typeof prisma.appointment.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

/**
 * Build the Prisma `where` clause for the requested scope.
 *
 *   - `personal`: rows with `organizationId IS NULL` AND the user
 *     participates (consultee on Consultation/Subscription/Trial OR
 *     consultant on the linked plan). v1 narrows to consultee for
 *     simplicity; consultant-side filtering can layer on later.
 *   - `org`: rows where `organizationId = orgId`. No user filter —
 *     MANAGER+ sees the org's full activity.
 *   - `all`: no scope filter; admin-only.
 */
function buildWhere(
  params: ListAppointmentsParams,
): Prisma.AppointmentWhereInput {
  const base: Prisma.AppointmentWhereInput = {
    ...(params.appointmentType && {
      appointmentType: params.appointmentType,
    }),
  };

  if (params.scope.kind === "personal") {
    return {
      ...base,
      organizationId: null,
      OR: [
        { consultation: { requestedBy: { userId: params.userId } } },
        { subscription: { requestedBy: { userId: params.userId } } },
        { trialSession: { consulteeProfile: { userId: params.userId } } },
      ],
    };
  }

  if (params.scope.kind === "org") {
    return { ...base, organizationId: params.scope.orgId };
  }

  // all — admin/staff
  return base;
}

export async function listAppointmentsScoped(
  params: ListAppointmentsParams,
): Promise<ListAppointmentsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  const [total, items] = await prisma.$transaction([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include: {
        consultation: {
          select: {
            consultationPlan: { select: { title: true } },
            requestedBy: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        subscription: {
          select: {
            subscriptionPlan: { select: { title: true } },
            requestedBy: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        webinar: { select: { webinarPlan: { select: { title: true } } } },
        class: { select: { classPlan: { select: { title: true } } } },
        trialSession: {
          select: {
            consulteeProfile: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
            consultantProfile: {
              select: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
