// File: schemas/PlanSchema.ts

import { z } from "zod";

export enum PlanDuration {
  ONE_MONTH = 'ONE_MONTH',
  THREE_MONTHS = 'THREE_MONTHS',
  SIX_MONTHS = 'SIX_MONTHS',
  TWELVE_MONTHS = 'TWELVE_MONTHS',
}

export enum PlanEmailSupport {
  GENERAL = 'GENERAL',
  PRIORITY = 'PRIORITY',
  DEDICATED = 'DEDICATED',
}

const basePlanSchema = z.object({
  id: z.string(),
  consultantProfileId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const consultationPlanSchema = basePlanSchema.extend({
  duration: z.number().positive(),
  price: z.number().nonnegative(),
});

export type ConsultationPlan = z.infer<typeof consultationPlanSchema>;

export const subscriptionPlanSchema = basePlanSchema.extend({
  duration: z.nativeEnum(PlanDuration),
  price: z.number().nonnegative(),
  callsPerWeek: z.number().int().positive(),
  videoMeetings: z.number().int().nonnegative(),
  emailSupport: z.nativeEnum(PlanEmailSupport),
});

export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

export const webinarPlanSchema = basePlanSchema.extend({
  duration: z.number().positive(),
  price: z.number().nonnegative(),
});

export type WebinarPlan = z.infer<typeof webinarPlanSchema>;

export const classPlanSchema = basePlanSchema.extend({
  duration: z.nativeEnum(PlanDuration),
  price: z.number().nonnegative(),
  callsPerWeek: z.number().int().positive(),
  videoMeetings: z.number().int().nonnegative(),
  emailSupport: z.nativeEnum(PlanEmailSupport),
});

export type ClassPlan = z.infer<typeof classPlanSchema>;

export const consultantPlansSchema = z.object({
  consultationPlans: z.array(consultationPlanSchema),
  subscriptionPlans: z.array(subscriptionPlanSchema),
  webinarPlans: z.array(webinarPlanSchema),
  classPlans: z.array(classPlanSchema),
});

export type ConsultantPlans = z.infer<typeof consultantPlansSchema>;