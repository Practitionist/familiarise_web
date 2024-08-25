// schemas/userSchema.ts
import { z } from "zod";

export const personalInfoAndRoleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  role: z.enum(["CONSULTANT", "CONSULTEE", "STAFF"]),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export type PersonalInfoAndRole = z.infer<typeof personalInfoAndRoleSchema>;

const slotSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
});

export const consultantProfileSchema = z.object({
  description: z.string().optional(),
  specialization: z.string().min(1, "Specialization is required"),
  experience: z.string().min(1, "Experience is required"),
  location: z.string().min(1, "Location is required"),
  domain: z.string().min(1, "Domain is required"),
  subDomains: z.string().min(1, "Sub-Domains are required"),
  tags: z.string().optional(),
  scheduleType: z.enum(['weekly', 'custom']),
  weeklySlots: z.record(z.array(slotSchema)),
  customSlots: z.record(z.array(slotSchema)),
});

export type ConsultantProfile = z.infer<typeof consultantProfileSchema>;

export const consulteeProfileSchema = z.object({
  location: z.string().optional(),
});

export type ConsulteeProfile = z.infer<typeof consulteeProfileSchema>;

const domainSchema = z.object({
  name: z.string(),
  subdomains: z.array(z.string()).optional(),
});

export const consulteePreferencesSchema = z.object({
  preferredConsultationMode: z.enum(["VIDEO", "AUDIO", "IN_PERSON"]),
  preferredLanguage: z.string(),
  specialRequirements: z.string().optional(),
  domains: z.array(domainSchema),
});

export type ConsulteePreferences = z.infer<typeof consulteePreferencesSchema>;

export const staffProfileSchema = z.object({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
});

export type StaffProfile = z.infer<typeof staffProfileSchema>;

export const staffResponsibilitiesSchema = z.object({
  responsibilities: z.string().min(1, "Responsibilities are required"),
});

export type StaffResponsibilities = z.infer<typeof staffResponsibilitiesSchema>;

export const WeeklySlotSchema = z.object({
  day: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
  startTime: z.string(),
  endTime: z.string(),
});

export const CustomSlotSchema = z.object({
  date: z.string(), // ISO date string
  startTime: z.string(),
  endTime: z.string(),
});

export const preferredScheduleSchema = z.object({
  scheduleType: z.enum(['weekly', 'custom']),
  weeklySlots: z.record(z.array(slotSchema)),
  customSlots: z.record(z.array(slotSchema)),
});

export type WeeklySlot = z.infer<typeof WeeklySlotSchema>;
export type CustomSlot = z.infer<typeof CustomSlotSchema>;
export type PreferredSchedule = z.infer<typeof preferredScheduleSchema>;