import { z } from "zod";
import { CollaboratorRole } from "@prisma/client";

/** Each plan type accepts its own subset of the one role enum. */
export const WEBINAR_COLLABORATOR_ROLES = [
  CollaboratorRole.CO_HOST,
  CollaboratorRole.MODERATOR,
  CollaboratorRole.GUEST_SPEAKER,
  CollaboratorRole.TECHNICAL_SUPPORT,
] as const;

export const CLASS_COLLABORATOR_ROLES = [
  CollaboratorRole.CO_INSTRUCTOR,
  CollaboratorRole.TEACHING_ASSISTANT,
  CollaboratorRole.GUEST_LECTURER,
  CollaboratorRole.CONTENT_CREATOR,
] as const;

export const COLLABORATOR_ROLES_BY_PLAN_TYPE = {
  webinar: WEBINAR_COLLABORATOR_ROLES,
  class: CLASS_COLLABORATOR_ROLES,
} as const satisfies Record<"webinar" | "class", readonly CollaboratorRole[]>;

/** A collaborator's share is a whole percent; the host keeps at least a tenth. */
export const MIN_SHARE_PERCENT = 1;
export const MAX_SHARE_PERCENT = 90;

export const sharePercentSchema = z
  .number({ required_error: "Enter a revenue share" })
  .int("The revenue share must be a whole percent")
  .min(
    MIN_SHARE_PERCENT,
    `The revenue share must be at least ${MIN_SHARE_PERCENT}%`,
  )
  .max(
    MAX_SHARE_PERCENT,
    `The revenue share cannot exceed ${MAX_SHARE_PERCENT}%`,
  );

const idSchema = z.string().trim().min(1).max(64);

export const planTypeSchema = z.enum(["webinar", "class"]);

export const planParamsSchema = z.object({ planId: idSchema });
export const memberParamsSchema = z.object({ planId: idSchema, id: idSchema });
export const collaborationParamsSchema = z.object({ id: idSchema });

const inviteBody = {
  consultantProfileId: idSchema,
  sharePercent: sharePercentSchema,
};

export const inviteCollaboratorSchemas = {
  webinar: z
    .object({ ...inviteBody, role: z.enum(WEBINAR_COLLABORATOR_ROLES) })
    .strict(),
  class: z
    .object({ ...inviteBody, role: z.enum(CLASS_COLLABORATOR_ROLES) })
    .strict(),
} as const;

const atLeastOneTerm = (body: { role?: unknown; sharePercent?: unknown }) =>
  body.role !== undefined || body.sharePercent !== undefined;

/** A pending invitation's terms: the role, the share, or both. */
export const updatePendingTermsSchemas = {
  webinar: z
    .object({
      role: z.enum(WEBINAR_COLLABORATOR_ROLES).optional(),
      sharePercent: sharePercentSchema.optional(),
    })
    .strict()
    .refine(atLeastOneTerm, "Change the role, the share, or both"),
  class: z
    .object({
      role: z.enum(CLASS_COLLABORATOR_ROLES).optional(),
      sharePercent: sharePercentSchema.optional(),
    })
    .strict()
    .refine(atLeastOneTerm, "Change the role, the share, or both"),
} as const;

/** The terms the invitee was looking at when they pressed Accept. */
export const seenTermsSchema = z
  .object({
    role: z.nativeEnum(CollaboratorRole),
    sharePercent: sharePercentSchema,
  })
  .strict();

export const respondToInvitationSchema = z.discriminatedUnion("response", [
  z.object({ response: z.literal("ACCEPTED"), seenTerms: seenTermsSchema }),
  z.object({ response: z.literal("DECLINED") }),
]);

export type SeenTerms = z.infer<typeof seenTermsSchema>;
