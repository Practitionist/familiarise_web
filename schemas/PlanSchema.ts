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
  title: z.string(),
  description: z.string().optional(),
  price: z.number(),
  durationInHours: z.number(),
  maxParticipants: z.number(),
  language: z.string().optional(),
  level: z.string().optional(),
  prerequisites: z.string().optional(),
  materialProvided: z.string().optional(),
  learningOutcomes: z.array(z.string()),
  topics: z.array(TagSchema),
});

export const ClassPlanSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string(),
  price: z.number(),
  certificateProvided: z.boolean(),
  durationInMonths: z.number(),
  callsPerWeek: z.number(),
  videoMeetings: z.number(),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]),
  maxParticipants: z.number(),
  language: z.string().optional(),
  level: z.string().optional(),
  prerequisites: z.string().optional(),
  materialProvided: z.string().optional(),
  learningOutcomes: z.array(z.string()),
  topics: z.array(TagSchema),
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

export type Domain = z.infer<typeof DomainSchema>;
export type SubDomain = z.infer<typeof SubDomainSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type ConsultantProfile = z.infer<typeof ConsultantProfileSchema>;
export type ConsultationPlan = z.infer<typeof ConsultationPlanSchema>;
export type SubscriptionPlan = z.infer<typeof SubscriptionPlanSchema>;
export type WebinarPlan = z.infer<typeof WebinarPlanSchema>;
export type ClassPlan = z.infer<typeof ClassPlanSchema>;
export type ClassContent = z.infer<typeof ClassContentSchema>;