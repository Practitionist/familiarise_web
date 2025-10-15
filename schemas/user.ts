// schemas/UserSchema.ts
import { z } from "zod";
import { experienceValidation } from "./shared";

export const PersonalInfoAndRoleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  emailVerified: z.date().optional(),
  image: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  onlineStatus: z.boolean().optional().default(false),
  timezone: z.string().optional(),
  onboardingCompleted: z.boolean().optional().default(false),
  role: z.enum(["CONSULTANT", "CONSULTEE", "ADMIN", "STAFF"]),
});

export type PersonalInfoAndRole = z.infer<typeof PersonalInfoAndRoleSchema>;

const _slotSchema = z.object({
  dayOfWeek: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  startTime: z.string(),
  endTime: z.string(),
});

export const ConsultantProfileSchema = z.object({
  description: z.string().optional(),
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
  experience: experienceValidation,
  rating: z.number().default(0),
  domain: z.object({
    id: z.string(),
    name: z.string(),
  }),
  subDomains: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      domainId: z.string(),
    }),
  ),
  tags: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      domainId: z.string(),
    }),
  ),
  scheduleType: z.enum(["WEEKLY", "CUSTOM"]),
  weeklySlots: z
    .array(
      z.object({
        dayOfWeekForStartsAt: z.enum([
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
        ]),
        availabilityStartsAt: z.string(),
        dayOfWeekForEndsAt: z.enum([
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
        ]),
        availabilityEndsAt: z.string(),
      }),
    )
    .optional(),
  customSlots: z
    .array(
      z.object({
        availabilityStartsAt: z.string(),
        availabilityEndsAt: z.string(),
      }),
    )
    .optional(),
});

export type ConsultantProfile = z.infer<typeof ConsultantProfileSchema>;

export const ConsulteeProfileSchema = z.object({
  education: z.string().optional(),
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredCommunicationMethod: z
    .enum(["VIDEO", "AUDIO", "IN_PERSON"])
    .default("VIDEO"),
  preferredLanguage: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
});

export type ConsulteeProfile = z.infer<typeof ConsulteeProfileSchema>;

export const ConsulteePreferencesSchema = z.object({
  preferredCommunicationMethod: z
    .enum(["VIDEO", "AUDIO", "IN_PERSON"])
    .default("VIDEO"),
  preferredLanguage: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
});

export type ConsulteePreferences = z.infer<typeof ConsulteePreferencesSchema>;

export const StaffProfileSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.boolean()).optional(),
});

export type StaffProfile = z.infer<typeof StaffProfileSchema>;

export const PreferredScheduleSchema = z.object({
  scheduleType: z.enum(["WEEKLY", "CUSTOM"]),
  weeklySlots: z
    .array(
      z.object({
        dayOfWeekForStartsAt: z.enum([
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
        ]),
        availabilityStartsAt: z.string(),
        dayOfWeekForEndsAt: z.enum([
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
        ]),
        availabilityEndsAt: z.string(),
      }),
    )
    .optional(),
  customSlots: z
    .array(
      z.object({
        availabilityStartsAt: z.string(),
        availabilityEndsAt: z.string(),
      }),
    )
    .optional(),
});

export type PreferredSchedule = z.infer<typeof PreferredScheduleSchema>;

export const CookiePreferenceSchema = z.object({
  essential: z.boolean().default(true),
  analytics: z.boolean().default(false),
  marketing: z.boolean().default(false),
});

export type CookiePreference = z.infer<typeof CookiePreferenceSchema>;

export const NotificationPreferenceSchema = z.object({
  allNotifications: z.boolean().default(true),
  mentions: z.boolean().default(false),
  directMessages: z.boolean().default(false),
  updates: z.boolean().default(false),
});

export type NotificationPreference = z.infer<
  typeof NotificationPreferenceSchema
>;
