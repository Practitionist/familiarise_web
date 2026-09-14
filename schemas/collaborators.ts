import { z } from "zod";
import { CollaboratorRole } from "@prisma/client";

// #784 — one DB enum, but each plan type still only accepts its own role
// subset (the old per-type enums enforced this at the DB layer).
export const WEBINAR_COLLABORATOR_ROLES = [
  CollaboratorRole.CO_HOST,
  CollaboratorRole.MODERATOR,
  CollaboratorRole.GUEST_SPEAKER,
  CollaboratorRole.TECHNICAL_SUPPORT,
] as const;

export const COHORT_COLLABORATOR_ROLES = [
  CollaboratorRole.CO_INSTRUCTOR,
  CollaboratorRole.TEACHING_ASSISTANT,
  CollaboratorRole.GUEST_LECTURER,
  CollaboratorRole.CONTENT_CREATOR,
] as const;

export const WebinarCollaboratorRoleEnum = z.enum(WEBINAR_COLLABORATOR_ROLES);
export const CohortCollaboratorRoleEnum = z.enum(COHORT_COLLABORATOR_ROLES);

// #1580 — what a seat grants is its `tier`, derived from the role on the
// server; the invite carries no per-capability booleans any more.
export const inviteCollaboratorSchema = z.object({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  revenueSharePercentage: z
    .number({ required_error: "Revenue share percentage is required" })
    .gt(0, "Revenue share percentage must be greater than 0")
    .lte(90, "Revenue share percentage cannot exceed 90"),
});

export const inviteWebinarCollaboratorSchema = inviteCollaboratorSchema.extend({
  role: WebinarCollaboratorRoleEnum,
});

export const inviteCohortCollaboratorSchema = inviteCollaboratorSchema.extend({
  role: CohortCollaboratorRoleEnum,
});

// #1580 C-P0-3 — the PATCH body was forwarded unvalidated. `updateCollaborator`
// changes only the share and the role.
export const updateWebinarCollaboratorSchema = inviteWebinarCollaboratorSchema
  .omit({ consultantProfileId: true })
  .partial();

export const updateCohortCollaboratorSchema = inviteCohortCollaboratorSchema
  .omit({ consultantProfileId: true })
  .partial();
