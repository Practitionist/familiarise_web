import { z } from "zod";

export const DomainSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
});

export const SubDomainSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  domainId: z.string(),
});

export const TagSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  domainId: z.string(),
});

export const ConsultantProfileSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
  experience: z.string().optional(),
  rating: z.number().optional(),
  domain: DomainSchema,
  subDomains: z.array(SubDomainSchema),
  tags: z.array(TagSchema),
  scheduleType: z.enum(["WEEKLY", "CUSTOM"]),
});

export const ConsultationPlanSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  durationInHours: z.number(),
  price: z.number(),
  language: z.string(),
  level: z.string(),
  prerequisites: z.string().optional(),
  materialProvided: z.string().optional(),
  learningOutcomes: z.array(z.string()),
});

export const SubscriptionPlanSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  durationInMonths: z.number(),
  price: z.number(),
  callsPerWeek: z.number(),
  videoMeetings: z.number(),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]),
  language: z.string(),
  level: z.string(),
  prerequisites: z.string().optional(),
  materialProvided: z.string().optional(),
  learningOutcomes: z.array(z.string()),
});

// Base schema for common fields
const BaseEventPlanSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  price: z.number().min(0, "Price must be non-negative"),
  maxParticipants: z.number().min(1, "At least one participant is required"),
  language: z.string().default("English"),
  level: z.string().default("Beginner"),
  prerequisites: z.string().optional().nullable(),
  materialProvided: z.string().optional().nullable(),
  learningOutcomes: z.array(z.string()),
  topics: z.array(z.string()),

  // Make consultant fields optional and nullable
  consultantProfileId: z.string().optional().nullable(),
  consultantProfile: z.any().optional().nullable(),
});

// Webinar specific schema
export const WebinarPlanSchema = BaseEventPlanSchema.extend({
  durationInHours: z.number()
    .min(0.5, "Duration must be at least 30 minutes")
    .refine(
      (val) => val * 60 % 30 === 0,
      "Duration must be in 30-minute increments"
    ),
  scheduledAt: z.string()
    .min(1, "Start time is required")
    .refine(
      (val) => {
        const date = new Date(val);
        return date.getMinutes() % 30 === 0;
      },
      "Please select either :00 or :30 for the minutes (e.g., 9:00 or 9:30)"
    )
    .refine(
      (val) => {
        const selectedDate = new Date(val);
        const minAllowedDate = new Date();
        minAllowedDate.setHours(minAllowedDate.getHours() + 1); // At least 1 hour in future
        return selectedDate > minAllowedDate;
      },
      "Start time must be at least 1 hour in the future"
    ),
});

// Class specific schema
export const ClassPlanSchema = BaseEventPlanSchema.extend({
  planType: z.literal("class"),
  durationInMonths: z.number().min(0.25, "Duration must be at least 1 week"),
  certificateProvided: z.boolean().default(false),
  callsPerWeek: z.number().min(0, "Calls per week must be non-negative"),
  videoMeetings: z.number().min(0, "Video meetings must be non-negative"),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]).default("GENERAL"),
  classContents: z
    .array(
      z.object({
        title: z.string().min(1, "Title is required"),
        description: z.string().min(1, "Description is required"),
        contentType: z.string().optional().nullable(),
        contentUrl: z.string().optional().nullable(),
        order: z.number().min(1, "Order must be a positive number"),
        hoursAllotted: z
          .number()
          .min(0.5, "Hours allotted must be at least 30 minutes"),
      }),
    )
    .optional()
    .default([]),
});

export const ClassContentSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string(),
  contentType: z.string().optional(),
  contentUrl: z.string().optional(),
  order: z.number(),
  hoursAllotted: z.number(),
});

// Add ConsultantPlans schema
export const ConsultantPlansSchema = z.object({
  consultationPlans: z.array(ConsultationPlanSchema),
  subscriptionPlans: z.array(SubscriptionPlanSchema),
  webinarPlans: z.array(WebinarPlanSchema),
  classPlans: z.array(ClassPlanSchema),
});

export type Domain = z.infer<typeof DomainSchema>;
export type SubDomain = z.infer<typeof SubDomainSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type ConsultantProfile = z.infer<typeof ConsultantProfileSchema>;
export type ConsultationPlan = z.infer<typeof ConsultationPlanSchema>;
export type SubscriptionPlan = z.infer<typeof SubscriptionPlanSchema>;
export type WebinarPlan = z.infer<typeof WebinarPlanSchema>;
export type ClassPlan = z.infer<typeof ClassPlanSchema>;
export type ClassContent = z.infer<typeof ClassContentSchema>;
export type ConsultantPlans = z.infer<typeof ConsultantPlansSchema>;
