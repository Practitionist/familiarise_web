import { z } from "zod";
import { TrialSessionStatusEnum } from "./enums";

export const CreateTrialSchema = z.object({
  consulteeProfileId: z.string().min(1, "Consultee profile ID is required"),
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  subscriptionPlanId: z.string().min(1, "Subscription plan ID is required"),
  notes: z.string().optional(),
});

export const UpdateTrialSchema = z.object({
  status: TrialSessionStatusEnum.optional(),
  scheduledTime: z.string().optional(),
  slotData: z
    .object({
      startsAt: z.string(),
      endsAt: z.string(),
      slotOfAvailabilityId: z.string(),
      slotType: z.enum(["WEEKLY", "CUSTOM"]),
    })
    .optional(),
  notes: z.string().optional(),
  // Required when status = CONVERTED — the subscription created via checkout
  subscriptionId: z.string().optional(),
});

export type CreateTrialInput = z.infer<typeof CreateTrialSchema>;
export type UpdateTrialInput = z.infer<typeof UpdateTrialSchema>;
