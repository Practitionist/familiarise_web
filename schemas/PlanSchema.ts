// File: schemas/PlanSchema.ts

import { z } from "zod";

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
  durationInHours: z.number().positive(),
  price: z.number().nonnegative(),
});

export const subscriptionPlanSchema = basePlanSchema.extend({
  durationInMonths: z.number().positive(),
  price: z.number().nonnegative(),
  callsPerWeek: z.number().int().positive(),
  videoMeetings: z.number().int().nonnegative(),
  emailSupport: z.nativeEnum(PlanEmailSupport),
});

export const webinarPlanSchema = basePlanSchema.extend({
  durationInHours: z.number().positive(),
  price: z.number().nonnegative(),
});

export const classPlanSchema = basePlanSchema.extend({
  durationInMonths: z.number().positive(),
  price: z.number().nonnegative(),
  callsPerWeek: z.number().int().positive(),
  videoMeetings: z.number().int().nonnegative(),
  emailSupport: z.nativeEnum(PlanEmailSupport),
});

export const consultantPlansSchema = z.object({
  consultationPlans: z.array(consultationPlanSchema),
  subscriptionPlans: z.array(subscriptionPlanSchema),
  webinarPlans: z.array(webinarPlanSchema),
  classPlans: z.array(classPlanSchema),
});

export type ConsultationPlan = z.infer<typeof consultationPlanSchema>;
export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;
export type WebinarPlan = z.infer<typeof webinarPlanSchema>;
export type ClassPlan = z.infer<typeof classPlanSchema>;
export type ConsultantPlans = z.infer<typeof consultantPlansSchema>;