/**
 * #support-hub — ONE authz gate for the appointment-scoped support routes
 * (detail, feedback, support thread). The support and feedback routes used to
 * carry twin `authorize` copies — Sonar flagged them as PR-wide duplication;
 * this is the single definition.
 *
 * The org-party branch (#support-hub, ADR 20) grants an org OPERATOR their OWN
 * conversation on their org's appointment — org-party intents only, never
 * anyone else's transcript. The grant is OPT-IN via the `orgParty` flag and
 * the return type narrows accordingly, so a route with no org-party surface
 * (detail, feedback) cannot silently accept the operator grant.
 */

import type { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import prisma from "@/lib/prisma";
import {
  readAppointmentDetail,
  canAccessAppointment,
  scopeAppointmentDetail,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";
import { supportError } from "@/lib/api/support-http";
import { seatOrganizationId } from "@/lib/booking/participants";

/** Coded authz failure — map through `appointmentAuthzError`. */
export type CodedAuthz = {
  code: "UNAUTHORIZED" | "NOT_FOUND" | "FORBIDDEN";
  status: number;
};

/** Org-party success — METADATA ONLY. `detail` is deliberately absent: the
 *  full appointment graph (recordings, payment, participants, sibling slots)
 *  must never be reachable through an org operator's grant (ADR 20), not even
 *  by a future consumer's convenience. */
export type PartyAuthz = {
  userId: string;
  isOrgParty: true;
  /** The appointment's owning org (org-party intent scoping). */
  organizationId: string | null;
};

/** Participant/staff success — carries the already-loaded detail so callers
 *  needing the payload reuse it instead of paying a second read. */
export type ParticipantAuthz = {
  userId: string;
  isOrgParty: false;
  /** The caller's seat org on a group session, else the appointment's org
   *  (CSAT attribution, #1852). */
  organizationId: string | null;
  detail: TAppointmentDetail;
};

export async function authorizeAppointment(
  appointmentId: string,
  orgParty: true,
): Promise<CodedAuthz | PartyAuthz | ParticipantAuthz>;
export async function authorizeAppointment(
  appointmentId: string,
  orgParty?: false,
): Promise<CodedAuthz | ParticipantAuthz>;
export async function authorizeAppointment(
  appointmentId: string,
  orgParty = false,
): Promise<CodedAuthz | PartyAuthz | ParticipantAuthz> {
  const session = await getSession(true);
  if (!session?.user?.id) return { code: "UNAUTHORIZED", status: 401 };
  const detail = await readAppointmentDetail(appointmentId);
  if (!detail) return { code: "NOT_FOUND", status: 404 };
  // #1852 — the caller's seat org on a group session, not the host's. The
  // org-party branch below keeps the host org: it is about the org's own
  // appointment, not about anyone's seat.
  const hostOrganizationId = detail.appointment.organizationId ?? null;
  const organizationId = await seatOrganizationId(
    prisma,
    detail.appointment,
    session.user.id,
  );
  // Staff who are also on the roster keep the whole view: privilege is
  // decided here, not by which branch admitted them.
  const privileged = isPrivileged(session.user.role);
  if (canAccessAppointment(session.user.id, detail)) {
    return {
      userId: session.user.id,
      isOrgParty: false,
      organizationId,
      detail: scopeAppointmentDetail(detail, session.user.id, privileged),
    };
  }
  if (privileged) {
    return {
      userId: session.user.id,
      isOrgParty: false,
      organizationId,
      detail,
    };
  }
  // #1527 QA — the support routes (the only `orgParty` callers) also admit
  // the PAYER: "Problem with this charge" opens a thread on the booking, and
  // a released or never-rostered seat must not lock the buyer out of asking
  // about their own money. Threads are keyed by (appointment, user), so this
  // reads only the payer's own conversation; group payments stay scoped.
  if (
    orgParty &&
    detail.appointment.payment.some((p) => p.userId === session.user.id)
  ) {
    return {
      userId: session.user.id,
      isOrgParty: false,
      organizationId,
      detail: scopeAppointmentDetail(detail, session.user.id, false),
    };
  }
  // #support-hub — org-party branch. Grants the operator their OWN thread on
  // this appointment (org-party intents only); never widens read access to
  // another user's conversation. Only routes that declare an org-party
  // surface may take this branch — and the grant returns no session content.
  if (orgParty) {
    if (hostOrganizationId) {
      const membership = await prisma.membership.findFirst({
        where: {
          userId: session.user.id,
          organizationId: hostOrganizationId,
          status: "ACTIVE",
        },
        select: { role: true },
      });
      if (membership && hasOrgPermission(membership.role, "operations.read")) {
        return {
          userId: session.user.id,
          isOrgParty: true,
          organizationId: hostOrganizationId,
        };
      }
    }
  }
  return { code: "FORBIDDEN", status: 403 };
}

/** Map a coded authz failure onto the support error envelope. */
export function appointmentAuthzError(
  auth: CodedAuthz,
  context: Record<string, unknown>,
): NextResponse {
  return supportError({ status: auth.status, code: auth.code, context });
}
