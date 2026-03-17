// schemas/user.ts
import { z } from "zod";
import { experienceValidation } from "./shared";

// #region Enums

export const GenderEnum = z.enum([
  "MALE",
  "FEMALE",
  "NON_BINARY",
  "PREFER_NOT_TO_SAY",
]);

export const CareerStageEnum = z.enum([
  "STUDENT",
  "EARLY_CAREER",
  "MID_CAREER",
  "SENIOR",
  "EXECUTIVE",
]);

export const AdminLevelEnum = z.enum(["SUPER_ADMIN", "ADMIN", "MODERATOR"]);

export const BudgetPreferenceEnum = z.enum([
  "BUDGET",
  "MODERATE",
  "PREMIUM",
  "FLEXIBLE",
]);

export const SessionTypeEnum = z.enum(["ONE_ON_ONE", "GROUP", "ASYNC_REVIEW"]);

export const UserRoleEnum = z.enum([
  "CONSULTANT",
  "CONSULTEE",
  "ADMIN",
  "STAFF",
]);

export const ScheduleTypeEnum = z.enum(["WEEKLY", "CUSTOM"]);

export const DayOfWeekEnum = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

// #endregion

// #region URL Validation Helpers

export const linkedinUrlSchema = z
  .string()
  .url("Please enter a valid URL")
  .refine(
    (url) => url.includes("linkedin.com"),
    "Please enter a valid LinkedIn URL (e.g., linkedin.com/in/yourprofile)",
  )
  .optional()
  .or(z.literal(""));

export const twitterUrlSchema = z
  .string()
  .url("Please enter a valid URL")
  .refine(
    (url) => url.includes("twitter.com") || url.includes("x.com"),
    "Please enter a valid Twitter/X URL",
  )
  .optional()
  .or(z.literal(""));

export const githubUrlSchema = z
  .string()
  .url("Please enter a valid URL")
  .refine(
    (url) => url.includes("github.com"),
    "Please enter a valid GitHub URL",
  )
  .optional()
  .or(z.literal(""));

export const websiteUrlSchema = z
  .string()
  .url("Please enter a valid website URL")
  .optional()
  .or(z.literal(""));

// #endregion

// #region Base User Schema

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
  role: UserRoleEnum,
  // New fields
  dateOfBirth: z.date().optional().nullable(),
  gender: GenderEnum.optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: linkedinUrlSchema,
  bio: z.string().max(160, "Bio must be 160 characters or less").optional(),
});

export type PersonalInfoAndRole = z.infer<typeof PersonalInfoAndRoleSchema>;

// #endregion

// #region Slot Schemas

export const WeeklySlotSchema = z.object({
  startDay: DayOfWeekEnum,
  startTimeUtc: z.number().int().min(0).max(1439),
  endDay: DayOfWeekEnum,
  endTimeUtc: z.number().int().min(0).max(1439),
});

export const CustomSlotSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
});

// #endregion

// #region Professional Background Schemas

export const WorkExperienceSchema = z.object({
  id: z.string().optional(),
  company: z.string().min(1, "Company name is required"),
  companyDomain: z.string().optional(),
  title: z.string().min(1, "Job title is required"),
  location: z.string().optional(),
  startDate: z.coerce.date({ required_error: "Start date is required" }),
  endDate: z.coerce.date().optional().nullable(),
  isCurrent: z.boolean().default(false),
  description: z.string().optional(),
});

export type WorkExperience = z.infer<typeof WorkExperienceSchema>;

export const CertificationSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Certification name is required"),
  issuingOrganization: z.string().min(1, "Issuing organization is required"),
  issueDate: z.coerce.date({ required_error: "Issue date is required" }),
  expiryDate: z.coerce.date().optional().nullable(),
  credentialId: z.string().optional(),
  credentialUrl: websiteUrlSchema,
});

export type Certification = z.infer<typeof CertificationSchema>;

export const EducationSchema = z.object({
  id: z.string().optional(),
  institution: z.string().min(1, "Institution name is required"),
  degree: z.string().min(1, "Degree is required"),
  fieldOfStudy: z.string().optional(),
  startYear: z.number().min(1900).max(2100).optional().nullable(),
  endYear: z.number().min(1900).max(2100).optional().nullable(),
  grade: z.string().optional(),
  activities: z.string().optional(),
  description: z.string().optional(),
});

export type Education = z.infer<typeof EducationSchema>;

// #endregion

// #region Consultant Profile Schema

export const ConsultantProfileSchema = z.object({
  description: z.string().optional(),
  experience: experienceValidation,
  rating: z.number().default(0),

  // New fields
  headline: z
    .string()
    .max(120, "Headline must be 120 characters or less")
    .optional(),
  websiteUrl: websiteUrlSchema,
  twitterUrl: twitterUrlSchema,
  githubUrl: githubUrlSchema,
  videoIntroUrl: websiteUrlSchema,
  languages: z.array(z.string()).default([]),
  toolsAndTechnologies: z.array(z.string()).default([]),
  mentoringStyle: z.string().optional(),
  sessionTypes: z.array(SessionTypeEnum).default([]),
  profileCompletionPercentage: z.number().min(0).max(100).default(0),
  isVerified: z.boolean().default(false),
  totalMenteesHelped: z.number().default(0),

  // Deprecated fields (kept for backward compatibility)
  qualifications: z.string().optional(),
  specialization: z.string().optional(),

  // Domain and expertise
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

  // Scheduling
  scheduleType: ScheduleTypeEnum,
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),

  // Professional background (new nested models)
  workExperiences: z.array(WorkExperienceSchema).optional(),
  certifications: z.array(CertificationSchema).optional(),
  education: z.array(EducationSchema).optional(),
});

export type ConsultantProfile = z.infer<typeof ConsultantProfileSchema>;

// #endregion

// #region Consultee Profile Schema

export const ConsulteeProfileSchema = z.object({
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredLanguage: z.string().optional(),
  goals: z.string().optional(),

  // New fields
  careerStage: CareerStageEnum.optional().nullable(),
  currentCompany: z.string().optional(),
  industry: z.string().optional(),
  skillsToDevelop: z.array(z.string()).default([]),
  budgetPreference: BudgetPreferenceEnum.optional().nullable(),

  // Education history (new nested model)
  educationHistory: z.array(EducationSchema).optional(),

  // Deprecated fields (kept for backward compatibility)
  education: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
});

export type ConsulteeProfile = z.infer<typeof ConsulteeProfileSchema>;

export const ConsulteePreferencesSchema = z.object({
  preferredLanguage: z.string().optional(),
  budgetPreference: BudgetPreferenceEnum.optional().nullable(),
  // Deprecated
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
  goals: z.string().optional(),
});

export type ConsulteePreferences = z.infer<typeof ConsulteePreferencesSchema>;

// #endregion

// #region Staff Profile Schema

export const StaffProfileSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.boolean()).optional(),

  // New fields
  employeeId: z.string().optional(),
  hireDate: z.coerce.date().optional().nullable(),
  reportsTo: z.string().optional(), // Manager's user ID
  skills: z.array(z.string()).default([]),
  workSchedule: z.string().optional(),
});

export type StaffProfile = z.infer<typeof StaffProfileSchema>;

// #endregion

// #region Admin Profile Schema (NEW)

export const AdminAccessScopeSchema = z.object({
  users: z
    .object({
      create: z.boolean().default(false),
      read: z.boolean().default(true),
      update: z.boolean().default(false),
      delete: z.boolean().default(false),
      roles: z.array(UserRoleEnum).default([]),
    })
    .optional(),
  financial: z
    .object({
      viewPayments: z.boolean().default(false),
      processRefunds: z.boolean().default(false),
      refundLimit: z.number().optional(),
      handleDisputes: z.boolean().default(false),
    })
    .optional(),
  content: z
    .object({
      manageDomains: z.boolean().default(false),
      moderateReviews: z.boolean().default(false),
      manageTopics: z.boolean().default(false),
    })
    .optional(),
  system: z
    .object({
      viewLogs: z.boolean().default(false),
      exportData: z.boolean().default(false),
      modifySettings: z.boolean().default(false),
    })
    .optional(),
  support: z
    .object({
      viewTickets: z.boolean().default(true),
      respondTickets: z.boolean().default(true),
      escalateTickets: z.boolean().default(false),
      closeTickets: z.boolean().default(false),
    })
    .optional(),
});

export type AdminAccessScope = z.infer<typeof AdminAccessScopeSchema>;

export const AdminProfileSchema = z.object({
  adminLevel: AdminLevelEnum,
  accessScope: AdminAccessScopeSchema.optional().nullable(),
  assignedRegions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export type AdminProfile = z.infer<typeof AdminProfileSchema>;

// Default access scopes for each admin level
export const DEFAULT_ADMIN_ACCESS_SCOPES: Record<string, AdminAccessScope> = {
  SUPER_ADMIN: {
    users: {
      create: true,
      read: true,
      update: true,
      delete: true,
      roles: ["CONSULTANT", "CONSULTEE", "ADMIN", "STAFF"],
    },
    financial: {
      viewPayments: true,
      processRefunds: true,
      handleDisputes: true,
    },
    content: { manageDomains: true, moderateReviews: true, manageTopics: true },
    system: { viewLogs: true, exportData: true, modifySettings: true },
    support: {
      viewTickets: true,
      respondTickets: true,
      escalateTickets: true,
      closeTickets: true,
    },
  },
  ADMIN: {
    users: {
      create: true,
      read: true,
      update: true,
      delete: false,
      roles: ["CONSULTANT", "CONSULTEE", "STAFF"],
    },
    financial: {
      viewPayments: true,
      processRefunds: true,
      refundLimit: 10000,
      handleDisputes: true,
    },
    content: { manageDomains: true, moderateReviews: true, manageTopics: true },
    system: { viewLogs: true, exportData: true, modifySettings: false },
    support: {
      viewTickets: true,
      respondTickets: true,
      escalateTickets: true,
      closeTickets: true,
    },
  },
  MODERATOR: {
    users: {
      create: false,
      read: true,
      update: false,
      delete: false,
      roles: [],
    },
    financial: {
      viewPayments: false,
      processRefunds: false,
      handleDisputes: false,
    },
    content: {
      manageDomains: false,
      moderateReviews: true,
      manageTopics: false,
    },
    system: { viewLogs: false, exportData: false, modifySettings: false },
    support: {
      viewTickets: true,
      respondTickets: true,
      escalateTickets: false,
      closeTickets: false,
    },
  },
};

// #endregion

// #region Schedule Schemas

export const PreferredScheduleSchema = z.object({
  scheduleType: ScheduleTypeEnum,
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),
});

export type PreferredSchedule = z.infer<typeof PreferredScheduleSchema>;

// #endregion

// #region Preferences Schemas

export const CookiePreferenceSchema = z.object({
  // Essential: Required for core functionality - authentication, security, CSRF tokens
  // Cannot be disabled by users. Examples: BetterAuth session, security tokens
  essential: z.boolean().default(true),

  // Analytics: Usage tracking and performance measurement
  // Examples: Google Analytics (GA4), Hotjar, Mixpanel, PostHog, Amplitude
  analytics: z.boolean().default(false),

  // Marketing: Advertising and retargeting
  // Examples: Facebook Pixel, Google Ads, LinkedIn Insight Tag, TikTok Pixel
  marketing: z.boolean().default(false),

  // Functional: Enhanced features and third-party integrations
  // Examples: Live chat (Intercom, Crisp), video embeds, social sharing, personalization
  functional: z.boolean().default(false),
});

export type CookiePreference = z.infer<typeof CookiePreferenceSchema>;

export const NotificationPreferenceSchema = z.object({
  allNotifications: z.boolean().default(true),

  // Channel preferences
  inAppEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(true),
  pushEnabled: z.boolean().default(false),

  // Legacy category preferences (kept for backward compatibility)
  mentions: z.boolean().default(false),
  directMessages: z.boolean().default(false),
  updates: z.boolean().default(false),

  // Category preferences
  appointmentReminders: z.boolean().default(true),
  paymentNotifications: z.boolean().default(true),
  supportUpdates: z.boolean().default(true),
  feedbackAlerts: z.boolean().default(true),
  trialNotifications: z.boolean().default(true),
  subscriptionAlerts: z.boolean().default(true),
  marketingEmails: z.boolean().default(false),

  // Quiet hours
  quietHoursEnabled: z.boolean().default(false),
  quietHoursStart: z.string().nullable().default(null),
  quietHoursEnd: z.string().nullable().default(null),
  quietHoursTimezone: z.string().nullable().default(null),
});

export type NotificationPreference = z.infer<
  typeof NotificationPreferenceSchema
>;

/** Schema for partial updates to notification preferences (PUT endpoint). */
export const NotificationPreferenceUpdateSchema =
  NotificationPreferenceSchema.partial();

// #endregion

// #region Combined/Full User Schema

export const FullUserSchema = z.object({
  id: z.string(),
  ...PersonalInfoAndRoleSchema.shape,
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  consultantProfile: ConsultantProfileSchema.optional().nullable(),
  consulteeProfile: ConsulteeProfileSchema.optional().nullable(),
  staffProfile: StaffProfileSchema.optional().nullable(),
  adminProfile: AdminProfileSchema.optional().nullable(),
  cookiePreferences: CookiePreferenceSchema.optional().nullable(),
  notificationPreferences: NotificationPreferenceSchema.optional().nullable(),
});

export type FullUser = z.infer<typeof FullUserSchema>;

// #endregion
