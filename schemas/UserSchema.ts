// schemas/userSchema.ts
import { z } from "zod";

export const PersonalInfoAndRoleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  role: z.enum(["CONSULTANT", "CONSULTEE", "STAFF"]),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export type PersonalInfoAndRole = z.infer<typeof PersonalInfoAndRoleSchema>;

const slotSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
});

export const ConsultantProfileSchema = z.object({
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

export type ConsultantProfile = z.infer<typeof ConsultantProfileSchema>;

export const ConsulteeProfileSchema = z.object({
  education: z.string().optional(),
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
});

export type ConsulteeProfile = z.infer<typeof ConsulteeProfileSchema>;

export const ConsulteePreferencesSchema = z.object({
  preferredCommunicationMethod: z.enum(["VIDEO", "AUDIO", "IN_PERSON"]),
  preferredLanguage: z.string(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.object({
    name: z.string(),
    skills: z.string().optional(),
  })).optional(),
});

export type ConsulteePreferences = z.infer<typeof ConsulteePreferencesSchema>;

export const StaffProfileSchema = z.object({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
});

export type StaffProfile = z.infer<typeof StaffProfileSchema>;

export const StaffResponsibilitiesSchema = z.object({
  responsibilities: z.string().min(1, "Responsibilities are required"),
});

export type StaffResponsibilities = z.infer<typeof StaffResponsibilitiesSchema>;

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

export const PreferredScheduleSchema = z.object({
  scheduleType: z.enum(['weekly', 'custom']),
  weeklySlots: z.record(z.array(slotSchema)),
  customSlots: z.record(z.array(slotSchema)),
});

export type WeeklySlot = z.infer<typeof WeeklySlotSchema>;
export type CustomSlot = z.infer<typeof CustomSlotSchema>;
export type PreferredSchedule = z.infer<typeof PreferredScheduleSchema>;