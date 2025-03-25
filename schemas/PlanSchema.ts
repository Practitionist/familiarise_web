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

export const WebinarPlanSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  price: z.number().nonnegative("Price must be non-negative"),
  durationInHours: z.number().positive("Duration must be positive"),
  maxParticipants: z
    .number()
    .int()
    .positive("Max participants must be a positive integer"),
  language: z.string().min(1, "Language is required"),
  level: z.string().min(1, "Level is required"),
  prerequisites: z.string().nullable(),
  materialProvided: z.string().nullable(),
  learningOutcomes: z
    .array(z.string())
    .min(1, "At least one learning outcome is required"),
  topics: z.array(z.string()).min(1, "At least one topic is required"),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  consultantProfileId: z.string().nullable(),
  consultantProfile: z
    .object({
      user: z.object({
        id: z.string(),
        name: z.string().nullable(),
        consultantProfileId: z.string().nullable(),
        address: z.string().nullable(),
        image: z.string().nullable(),
        email: z.string().nullable(),
        staffProfileId: z.string().nullable(),
      }),
    })
    .nullable(),
});

export const ClassPlanSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  price: z.number().nonnegative("Price must be non-negative"),
  certificateProvided: z.boolean(),
  durationInMonths: z
    .number()
    .int()
    .positive("Duration in months must be a positive integer"),
  callsPerWeek: z
    .number()
    .int()
    .nonnegative("Calls per week must be non-negative"),
  videoMeetings: z
    .number()
    .int()
    .nonnegative("Video meetings must be non-negative"),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]),
  maxParticipants: z
    .number()
    .int()
    .positive("Max participants must be a positive integer"),
  language: z.string().min(1, "Language is required"),
  level: z.string().min(1, "Level is required"),
  prerequisites: z.string().nullable(),
  materialProvided: z.string().nullable(),
  learningOutcomes: z
    .array(z.string())
    .min(1, "At least one learning outcome is required"),
  topics: z.array(z.string()).min(1, "At least one topic is required"),
  classContents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      contentType: z.string().nullable(),
      contentUrl: z.string().nullable(),
      order: z.number(),
      hoursAllotted: z.number(),
      createdAt: z.date(),
      updatedAt: z.date(),
      classPlanId: z.string(),
    }),
  ),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  consultantProfileId: z.string().nullable(),
  consultantProfile: z
    .object({
      user: z.object({
        id: z.string(),
        name: z.string().nullable(),
        consultantProfileId: z.string().nullable(),
        address: z.string().nullable(),
        image: z.string().nullable(),
        email: z.string().nullable(),
        staffProfileId: z.string().nullable(),
      }),
    })
    .nullable(),
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
