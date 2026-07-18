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
 *     participates — either as the consultee (booked the session) OR as the
 *     consultant (owns the linked plan). Both sides are covered (#674): a
 *     consultant's own B2C sessions appear in their personal list; org-hosted
 *     sessions carry an organizationId and fall under `org` scope instead.
 *   - `org`: rows where `organizationId = orgId`. No user filter —
 *     MANAGER+ sees the org's full activity.
 *   - `all`: no scope filter; admin-only.
 */
export function buildWhere(
  params: ListAppointmentsParams,
): Prisma.AppointmentWhereInput {
  const base: Prisma.AppointmentWhereInput = {
    ...(params.appointmentType && {
      appointmentType: params.appointmentType,
    }),
  };

  if (params.scope.kind === "personal") {
    // Consultee arms stay scoped to non-org bookings: a learner's sponsored
    // sessions are org business (they surface on the home dashboard with a
    // "Sponsored · Org" pill and under org scope), deliberately kept out of the
    // personal LIST. Consultant arms are NOT so constrained — an independent
    // consultant (or a host EXPERT) has no org-scope access, so every session
    // they DELIVER must appear here, sponsored or not. The org relation is
    // included so the client can badge the sponsored ones.
    const uid = params.userId;
    return {
      ...base,
      OR: [
        // Consultee side — self-funded (non-org) bookings only.
        { organizationId: null, consultation: { requestedBy: { userId: uid } } },
        { organizationId: null, subscription: { requestedBy: { userId: uid } } },
        {
          organizationId: null,
          trialSession: { consulteeProfile: { userId: uid } },
        },
        // Consultant side (#674) — every session the user delivers.
        { consultation: { consultationPlan: { consultantProfile: { userId: uid } } } },
        { subscription: { subscriptionPlan: { consultantProfile: { userId: uid } } } },
        { trialSession: { consultantProfile: { userId: uid } } },
        { webinar: { webinarPlan: { consultantProfile: { userId: uid } } } },
        { class: { classPlan: { consultantProfile: { userId: uid } } } },
      ],
    };
  }

  if (params.scope.kind === "orgMember") {
    // #org-appts — ONE member's own appointments WITHIN this org: sessions they
    // booked (as a learner) OR deliver (as an expert). Hoists `organizationId:
    // orgId` so it is strictly this org's activity. Distinct from `org`
    // (all-org, MANAGER+).
    //
    // Trials are intentionally EXCLUDED: a trial is a B2C acquisition session
    // (org-tagged only for conversion analytics, never org-sponsored), so it
    // belongs in the member's PERSONAL appointments, not the org view.
    const uid = params.scope.userId;
    return {
      ...base,
      organizationId: params.scope.orgId,
      OR: [
        // Consumed as a learner (org-sponsored bookings).
        { consultation: { requestedBy: { userId: uid } } },
        { subscription: { requestedBy: { userId: uid } } },
        // Delivered as an expert (owns the plan).
        { consultation: { consultationPlan: { consultantProfile: { userId: uid } } } },
        { subscription: { subscriptionPlan: { consultantProfile: { userId: uid } } } },
        { webinar: { webinarPlan: { consultantProfile: { userId: uid } } } },
        { class: { classPlan: { consultantProfile: { userId: uid } } } },
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
