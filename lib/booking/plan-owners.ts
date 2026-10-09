/**
 * Who may act on a booking as its consultant.
 *
 * This was written out by hand at every route that needed it, and the copies
 * drifted: the manage-timings read omitted `trial`, so a consultant
 * opening the timings of their own trial was refused by a check the reschedule
 * route passed. Two hand-maintained ownership predicates is one too many —
 * the failure mode is silent, and it is an authorization decision.
 *
 * Collaborators count only for webinars and classes. Consultation and
 * subscription plans have no collaborator relation on this read, and widening
 * the set here would grant access the other surfaces do not.
 */

import type { CollaboratorRole } from "@prisma/client";
import { PRESENTER_ROLES } from "@/lib/collaborators/roles";

interface PlanOwner {
  consultantProfile?: { id: string } | null;
}

interface PlanCollaboratorEntry {
  status?: string;
  role?: string;
  tier?: string;
  consultantProfile?: { id: string } | null;
}

interface PlanWithCollaborators extends PlanOwner {
  collaborators?: PlanCollaboratorEntry[] | null;
}

export interface AppointmentPlanOwnership {
  consultation?: { consultationPlan?: PlanOwner | null } | null;
  subscription?: { subscriptionPlan?: PlanOwner | null } | null;
  webinar?: { webinarPlan?: PlanWithCollaborators | null } | null;
  class?: { classPlan?: PlanWithCollaborators | null } | null;
  trial?: { subscriptionPlan?: PlanOwner | null } | null;
}

export function resolvePlanOwnerIds(
  appointment: AppointmentPlanOwnership,
): string[] {
  return [
    appointment.consultation?.consultationPlan?.consultantProfile?.id,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.id,
    appointment.webinar?.webinarPlan?.consultantProfile?.id,
    appointment.class?.classPlan?.consultantProfile?.id,
    appointment.trial?.subscriptionPlan?.consultantProfile?.id,
  ].filter((id): id is string => Boolean(id));
}

function isPresenterCollaborator(collaborator: PlanCollaboratorEntry): boolean {
  if (collaborator.status && collaborator.status !== "ACCEPTED") return false;
  if (collaborator.tier) return collaborator.tier === "PRESENTER";
  if (collaborator.role) {
    return PRESENTER_ROLES.includes(collaborator.role as CollaboratorRole);
  }
  return true;
}

export function resolvePlanPresenterIds(
  appointment: AppointmentPlanOwnership,
): string[] {
  return [
    ...resolvePlanOwnerIds(appointment),
    ...(appointment.webinar?.webinarPlan?.collaborators ?? [])
      .filter(isPresenterCollaborator)
      .map((collaborator) => collaborator.consultantProfile?.id),
    ...(appointment.class?.classPlan?.collaborators ?? [])
      .filter(isPresenterCollaborator)
      .map((collaborator) => collaborator.consultantProfile?.id),
  ].filter((id): id is string => Boolean(id));
}
