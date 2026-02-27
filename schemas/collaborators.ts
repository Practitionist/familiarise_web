import { z } from "zod";
import { WebinarCollaboratorRole, ClassCollaboratorRole } from "@prisma/client";

export const WebinarCollaboratorRoleEnum = z.nativeEnum(
  WebinarCollaboratorRole,
);
export const ClassCollaboratorRoleEnum = z.nativeEnum(ClassCollaboratorRole);

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

export const inviteClassCollaboratorSchema = inviteCollaboratorSchema.extend({
  role: ClassCollaboratorRoleEnum,
});

export type InviteCollaboratorInput = z.infer<typeof inviteCollaboratorSchema>;
export type InviteWebinarCollaboratorInput = z.infer<
  typeof inviteWebinarCollaboratorSchema
>;
export type InviteClassCollaboratorInput = z.infer<
  typeof inviteClassCollaboratorSchema
>;
