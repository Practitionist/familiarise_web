import { z } from "zod";
import { RequestStatusEnum } from "./enums";

export const UpdateSubscriptionStatusSchema = z.object({
  id: z.string().min(1, "Subscription ID is required"),
  status: RequestStatusEnum,
});

export const UpdateSubscriptionSchema = z.object({
  schedulingPeriodStartsAt: z.string().optional(),
  schedulingPeriodEndsAt: z.string().optional(),
  requestStatus: RequestStatusEnum.optional(),
  requestNotes: z.string().optional(),
  feedbackFromConsultee: z.string().optional(),
  feedbackFromConsultant: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  planId: z.string().optional(),
});

export const PatchSubscriptionStatusSchema = z.object({
  status: RequestStatusEnum,
});
