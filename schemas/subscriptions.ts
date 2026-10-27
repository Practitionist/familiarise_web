import { z } from "zod";
import { RequestStatusEnum } from "./enums";

export const UpdateSubscriptionStatusSchema = z.object({
  id: z.string().min(1, "Subscription ID is required"),
  status: RequestStatusEnum,
});

export const PatchSubscriptionStatusSchema = z.object({
  status: RequestStatusEnum,
});
