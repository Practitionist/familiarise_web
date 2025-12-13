import { z } from "zod";
import {
  hasDuplicates,
  isMeaningfulText,
  isProfanityFree,
} from "@/utils/contentValidation";
import { experienceValidation } from "./shared";

// Separate refine functions for different validation types
const profanityFreeRefinement = (value: string) => {
  return isProfanityFree(value);
};

const meaningfulContentRefinement = (value: string) => {
  return isMeaningfulText(value);
};

const profanityFreeArrayRefinement = (values: string[]) => {
  for (const value of values) {
    if (!isProfanityFree(value)) {
      return false;
    }
  }
  return true;
};

const meaningfulArrayContentRefinement = (values: string[]) => {
  for (const value of values) {
    if (!isMeaningfulText(value)) {
      return false;
    }
  }
  return true;
};

const noDuplicatesRefinement = (values: string[]) => {
  return !hasDuplicates(values);
};

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
  experience: experienceValidation,
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
  priceCurrency: z.string().min(1, "Currency is required").default("INR"),
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
  priceCurrency: z.string().min(1, "Currency is required").default("INR"),
  callsPerWeek: z.number(),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]),
  language: z.string(),
  level: z.string(),
  prerequisites: z.string().optional(),
  materialProvided: z.string().optional(),
  learningOutcomes: z.array(z.string()),
});

// Base schema for common fields
const BaseEventPlanSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .refine(
      meaningfulContentRefinement,
      "Title contains nonsensical text or gibberish",
    )
    .refine(profanityFreeRefinement, "Title contains inappropriate language"),
  description: z
    .string()
    .min(1, "Description is required")
    .refine(
      meaningfulContentRefinement,
      "Description contains nonsensical text or gibberish",
    )
    .refine(
      profanityFreeRefinement,
      "Description contains inappropriate language",
    ),
  price: z.number().min(0, "Price must be non-negative"),
  priceCurrency: z.string().min(1, "Currency is required").default("INR"),
  maxParticipants: z.number().min(1, "At least one participant is required"),
  language: z
    .string()
    .default("English")
    .refine(
      meaningfulContentRefinement,
      "Language contains nonsensical text or gibberish",
    )
    .refine(
      profanityFreeRefinement,
      "Language contains inappropriate language",
    ),
  level: z
    .string()
    .default("Beginner")
    .refine(
      meaningfulContentRefinement,
      "Level contains nonsensical text or gibberish",
    )
    .refine(profanityFreeRefinement, "Level contains inappropriate language"),
  prerequisites: z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || meaningfulContentRefinement(val),
      "Prerequisites contain nonsensical text or gibberish",
    )
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      "Prerequisites contain inappropriate language",
    ),
  materialProvided: z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || meaningfulContentRefinement(val),
      "Materials contain nonsensical text or gibberish",
    )
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      "Materials contain inappropriate language",
    ),
  learningOutcomes: z
    .array(z.string().min(1, "Learning outcome cannot be empty"))
    .min(1, "At least one learning outcome is required")
    .refine(
      noDuplicatesRefinement,
      "Duplicate learning outcomes are not allowed",
    )
    .refine(
      meaningfulArrayContentRefinement,
      "Learning outcomes contain nonsensical text or gibberish",
    )
    .refine(
      profanityFreeArrayRefinement,
      "Learning outcomes contain inappropriate language",
    ),
  topics: z
    .array(z.string().min(1, "Topic cannot be empty"))
    .min(1, "At least one topic is required")
    .refine(noDuplicatesRefinement, "Duplicate topics are not allowed")
    .refine(
      meaningfulArrayContentRefinement,
      "Topics contain nonsensical text or gibberish",
    )
    .refine(
      profanityFreeArrayRefinement,
      "Topics contain inappropriate language",
    ),

  // Make consultant fields optional and nullable
  consultantProfileId: z.string().optional().nullable(),
  consultantProfile: z.any().optional().nullable(),
});

// Create a factory function for unique title validator
export const createUniqueTitleValidator = (
  checkFunction: (title: string) => Promise<boolean>,
  eventType: string,
) => {
  return z
    .object({
      title: z.string().refine(
        async (title) => {
          // Only run this check when submitted (during client validation this will return true)
          // Actual DB check will happen in the service layer
          const isDuplicate = await checkFunction(title);
          return !isDuplicate;
        },
        {
          message: `A ${eventType} with this title already exists`,
        },
      ),
    })
    .partial();
};

// Webinar specific schema
export const WebinarPlanSchema = BaseEventPlanSchema.extend({
  certificateProvided: z.boolean().default(false),
  durationInHours: z
    .number()
    .min(0.5, "Duration must be at least 30 minutes")
    .refine(
      (val) => (val * 60) % 30 === 0,
      "Duration must be in 30-minute increments",
    ),
  scheduledAt: z
    .string()
    .min(1, "Start time is required")
    .refine((val) => {
      const date = new Date(val);
      return date.getMinutes() % 30 === 0;
    }, "Please select either :00 or :30 for the minutes (e.g., 9:00 or 9:30)")
    .refine((val) => {
      const selectedDate = new Date(val);
      const minAllowedDate = new Date();
      minAllowedDate.setHours(minAllowedDate.getHours() + 1); // At least 1 hour in future
      return selectedDate > minAllowedDate;
    }, "Start time must be at least 1 hour in the future"),
});

// Class specific schema
export const ClassContentSchema = z.object({
  id: z.string().optional(),
  title: z
    .string()
    .min(1, "Title is required")
    .refine(
      meaningfulContentRefinement,
      "Title contains nonsensical text or gibberish",
    )
    .refine(profanityFreeRefinement, "Title contains inappropriate language"),
  description: z
    .string()
    .min(1, "Description is required")
    .refine(
      meaningfulContentRefinement,
      "Description contains nonsensical text or gibberish",
    )
    .refine(
      profanityFreeRefinement,
      "Description contains inappropriate language",
    ),
  contentType: z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || meaningfulContentRefinement(val),
      "Content type contains nonsensical text or gibberish",
    )
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      "Content type contains inappropriate language",
    ),
  contentUrl: z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || meaningfulContentRefinement(val),
      "URL contains nonsensical text or gibberish",
    )
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      "URL contains inappropriate language",
    ),
  order: z.number().min(1, "Order must be a positive number"),
  hoursAllotted: z
    .number()
    .min(0.5, "Hours allotted must be at least 30 minutes"),
  // Optional fields for Prisma compatibility
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  classPlanId: z.string().optional(),
});

export const ClassPlanSchema = BaseEventPlanSchema.extend({
  planType: z.literal("class"),
  durationInMonths: z.number().min(0.25, "Duration must be at least 1 week"),
  certificateProvided: z.boolean().default(false),
  meetingsPerWeek: z.number().min(0, "Meetings per week must be non-negative"),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]).default("GENERAL"),
  classContents: z
    .array(ClassContentSchema)
    .min(1, "At least one class content item is required")
    .default([])
    .refine((contents: z.infer<typeof ClassContentSchema>[]) => {
      const titles = contents.map((c: z.infer<typeof ClassContentSchema>) =>
        c.title.trim().toLowerCase(),
      );
      return new Set(titles).size === titles.length;
    }, "Class contents must have unique titles"),
  startDate: z.date().optional().nullable(),
  endDate: z.date().optional().nullable(),
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
