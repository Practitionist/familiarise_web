import { z } from "zod";
import { RequestStatusEnum } from "./enums";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";

export const UpdateSubscriptionStatusSchema = z.object({
  id: z.string().min(1, "Subscription ID is required"),
  status: RequestStatusEnum,
});

// #836 — status is NOT writable via PUT: status changes flow only
// through PATCH, where the allowed-from guard rides the WHERE clause.
// Strict + ISO datetimes + start<end (#1717 security pass); who may set
// which field is unchanged.
export const UpdateSubscriptionSchema = z
  .object({
    schedulingPeriodStartsAt: z.string().datetime({ offset: true }).optional(),
    schedulingPeriodEndsAt: z.string().datetime({ offset: true }).optional(),
    requestNotes: z.string().max(MAX_TEXT_LENGTH).optional(), // #831
    planId: z.string().optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.schedulingPeriodStartsAt ||
      !v.schedulingPeriodEndsAt ||
      new Date(v.schedulingPeriodStartsAt) < new Date(v.schedulingPeriodEndsAt),
    {
      message: "schedulingPeriodStartsAt must be before schedulingPeriodEndsAt",
      path: ["schedulingPeriodEndsAt"],
    },
  );

export const PatchSubscriptionStatusSchema = z.object({
  status: RequestStatusEnum,
});
