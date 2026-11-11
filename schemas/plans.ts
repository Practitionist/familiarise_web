import { z } from "zod";
import { Currency, OfferingPlanStatus, PlanLevel } from "@prisma/client";
import {
  hasDuplicates,
  isMeaningfulText,
  isProfanityFree,
} from "@/utils/contentValidation";
import { experienceValidation } from "./shared";
import { MAX_GROUP_SESSION_PARTICIPANTS } from "@/lib/events/capacity";
import { isOnEventLattice } from "@/lib/booking/event-time-rules";

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

// Optional free-text bullet list. Same guarantees as `learningOutcomes` but
// nothing is required, because positioning copy is opt-in on every plan type.
const optionalBulletList = (label: string) =>
  z
    .array(z.string().min(1, `${label} entry cannot be empty`))
    .max(12, `At most 12 ${label.toLowerCase()} entries`)
    .default([])
    .refine(noDuplicatesRefinement, `Duplicate ${label.toLowerCase()} entries`)
    .refine(
      meaningfulArrayContentRefinement,
      `${label} contains nonsensical text or gibberish`,
    )
    .refine(
      profanityFreeArrayRefinement,
      `${label} contains inappropriate language`,
    );

// ── Shared plan-field builders ─────────────────────────────────────────────
// The four plan schemas are parallel by design; these builders keep them from
// being parallel COPIES. A rule change (the topic cap, the price ceiling, a
// refine message) must land once, not four times — verbatim repeats of these
// blocks also trip SonarCloud's new-code duplication gate.

const planTitleSchema = z
  .string()
  .min(1, "Title is required")
  .max(100, "Title must be 100 characters or less")
  .refine(
    meaningfulContentRefinement,
    "Title contains nonsensical text or gibberish",
  )
  .refine(profanityFreeRefinement, "Title contains inappropriate language");

// Required at the validation edge even though the DB columns stay nullable
// (ClassPlan's was relaxed so legacy rows survive); authoring always has a
// description.
const requiredDescriptionSchema = z
  .string()
  .min(1, "Description is required")
  .refine(
    meaningfulContentRefinement,
    "Description contains nonsensical text or gibberish",
  )
  .refine(
    profanityFreeRefinement,
    "Description contains inappropriate language",
  );

// Optional free text (prerequisites, materials). Empty/absent is fine; what
// IS present must be meaningful and profanity-free.
const optionalFreeText = (label: string) =>
  z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || meaningfulContentRefinement(val),
      `${label} contain nonsensical text or gibberish`,
    )
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      `${label} contain inappropriate language`,
    );

const learningOutcomesSchema = z
  .array(z.string().min(1, "Learning outcome cannot be empty"))
  .min(1, "At least one learning outcome is required")
  .refine(noDuplicatesRefinement, "Duplicate learning outcomes are not allowed")
  .refine(
    meaningfulArrayContentRefinement,
    "Learning outcomes contain nonsensical text or gibberish",
  )
  .refine(
    profanityFreeArrayRefinement,
    "Learning outcomes contain inappropriate language",
  );

const topicsSchema = z
  .array(z.string().min(1, "Topic cannot be empty"))
  .min(1, "At least one topic is required")
  .max(10, "At most 10 topics are allowed")
  .refine(noDuplicatesRefinement, "Duplicate topics are not allowed")
  .refine(
    meaningfulArrayContentRefinement,
    "Topics contain nonsensical text or gibberish",
  )
  .refine(
    profanityFreeArrayRefinement,
    "Topics contain inappropriate language",
  );

// Paise at the API edge (#780): the form edits rupees and the services
// multiply by 100 before sending. Cap is ₹10,00,000.
const priceSchema = z
  .number()
  .min(0, "Price must be non-negative")
  .max(100000000, "Price cannot exceed ₹10,00,000");

// Recording is an explicit per-plan opt-in on all four types, defaulting off.
const recordingShape = {
  recordingEnabled: z.boolean().default(false),
};

export const PlanFaqSchema = z.object({
  id: z.string().optional(),
  question: z
    .string()
    .min(1, "Question is required")
    .max(200, "Question must be 200 characters or less")
    .refine(
      meaningfulContentRefinement,
      "Question contains nonsensical text or gibberish",
    )
    .refine(
      profanityFreeRefinement,
      "Question contains inappropriate language",
    ),
  answer: z
    .string()
    .min(1, "Answer is required")
    .max(1000, "Answer must be 1000 characters or less")
    .refine(
      meaningfulContentRefinement,
      "Answer contains nonsensical text or gibberish",
    )
    .refine(profanityFreeRefinement, "Answer contains inappropriate language"),
  order: z.number().int().min(0).default(0),
});

// Buyer-facing positioning shared by all four plan types. Kept as a plain
// shape so it can be spread into schemas that do and do not extend the
// webinar/class base.
export const planPositioningShape = {
  subtitle: z
    .string()
    .max(160, "Subtitle must be 160 characters or less")
    .optional()
    .nullable()
    .refine(
      (val) => !val || meaningfulContentRefinement(val),
      "Subtitle contains nonsensical text or gibberish",
    )
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      "Subtitle contains inappropriate language",
    ),
  targetAudience: optionalBulletList("Target audience"),
  whatsIncluded: optionalBulletList("What's included"),
  faqs: z.array(PlanFaqSchema).max(20, "At most 20 FAQs").default([]),
};

export const planLevelSchema = z
  .nativeEnum(PlanLevel)
  .default(PlanLevel.BEGINNER);

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

// Curriculum / roadmap entries. Declared ahead of the plan schemas because both
// SubscriptionPlanSchema and ClassPlanSchema embed them.
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
  description: requiredDescriptionSchema,
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
  order: z.number().optional(),
  hoursAllotted: z
    .number()
    .min(0.5, "Hours allotted must be at least 30 minutes"),
  // No gibberish refinement here — "Week 1" and "Sprint 2" are exactly the
  // short alphanumeric strings isMeaningfulText rejects.
  sectionLabel: z
    .string()
    .max(40, "Section label must be 40 characters or less")
    .optional()
    .nullable()
    .refine(
      (val) => !val || profanityFreeRefinement(val),
      "Section label contains inappropriate language",
    ),
  outcomes: optionalBulletList("Session outcomes"),
  // Optional fields for Prisma compatibility
  createdAt: z.union([z.date(), z.string()]).optional(),
  updatedAt: z.union([z.date(), z.string()]).optional(),
  classPlanId: z.string().optional(),
});

// Subscription roadmap entries carry the same shape; only the owning FK differs.
export const SubscriptionContentSchema = ClassContentSchema.omit({
  classPlanId: true,
}).extend({
  subscriptionPlanId: z.string().optional(),
});

// #1527 Q4 — absent means PUBLISHED (the column default), so older API
// clients keep publishing exactly as before.
const offeringPlanStatusSchema = z.nativeEnum(OfferingPlanStatus).optional();

export const ConsultationPlanSchema = z.object({
  id: z.string().optional(),
  title: planTitleSchema,
  // Required at the validation edge even though the DB column stays nullable
  // (relaxed so legacy rows survive); authoring always has a description.
  description: requiredDescriptionSchema,
  durationInHours: z
    .number()
    .min(0.5, "Duration must be at least 30 minutes")
    .max(8, "Duration cannot exceed 8 hours")
    .refine(
      (val) => (val * 60) % 30 === 0,
      "Duration must be in 30-minute increments",
    ),
  price: priceSchema,
  priceCurrency: z.nativeEnum(Currency).default(Currency.INR),
  language: z.string().min(1, "Language is required"),
  level: planLevelSchema,
  prerequisites: optionalFreeText("Prerequisites"),
  materialProvided: optionalFreeText("Materials"),
  learningOutcomes: learningOutcomesSchema,
  topics: topicsSchema,
  status: offeringPlanStatusSchema,
  ...recordingShape,
  ...planPositioningShape,
});

/**
 * The recurring cadence every plan door must accept identically: whole sessions
 * a week (1–7) and a session length on the 30-minute booking grid (30 min–4 h).
 * The plan editor, the class plan POST and the org catalog all parse through it.
 */
export const sessionsPerWeekSchema = z
  .number()
  .int("Sessions per week must be a whole number")
  .min(1, "At least one session per week is required")
  .max(7, "Cannot exceed 7 sessions per week");

export const sessionDurationInHoursSchema = z
  .number()
  .min(0.5, "Session duration must be at least 30 minutes")
  .max(4, "Session duration cannot exceed 4 hours")
  .refine(
    (val) => (val * 60) % 30 === 0,
    "Session duration must be in 30-minute increments",
  );

export const PlanCadenceSchema = z.object({
  sessionsPerWeek: sessionsPerWeekSchema,
  sessionDurationInHours: sessionDurationInHoursSchema,
});

export const SubscriptionPlanSchema = z.object({
  id: z.string().optional(),
  title: planTitleSchema,
  // Required at the validation edge even though the DB column stays nullable
  // (relaxed so legacy rows survive); authoring always has a description.
  description: requiredDescriptionSchema,
  durationInMonths: z
    .number()
    .min(1, "Duration must be at least 1 month")
    .max(24, "Duration cannot exceed 24 months"),
  // A weeks plan's length; null keeps a months plan. Months are derived from it.
  durationInWeeks: z
    .number()
    .int("Weeks must be a whole number")
    .min(1, "A plan runs at least 1 week")
    .max(52, "A plan runs at most 52 weeks")
    .nullable()
    .optional(),
  price: priceSchema,
  priceCurrency: z.nativeEnum(Currency).default(Currency.INR),
  trialEnabled: z.boolean().optional(),
  trialDurationMinutes: z
    .number()
    .int("Trial duration must be a whole number of minutes")
    .min(15, "Trial duration must be at least 15 minutes")
    .max(120, "Trial duration cannot exceed 120 minutes")
    .optional(),
  // ₹0 stays allowed — the plan form adds deliberate friction instead.
  trialPriceInPaise: z
    .number()
    .int("Trial price must be a whole paise amount")
    .min(0, "Trial price must be non-negative")
    .optional(),
  sessionsPerWeek: sessionsPerWeekSchema,
  // Sessions are booked as 30-minute atoms; any other length would be sold as
  // one length and booked as the next.
  sessionDurationInHours: sessionDurationInHoursSchema.default(1),
  emailSupport: z.enum(["GENERAL", "PRIORITY", "DEDICATED"]).default("GENERAL"),
  language: z.string().min(1, "Language is required"),
  level: planLevelSchema,
  prerequisites: optionalFreeText("Prerequisites"),
  materialProvided: optionalFreeText("Materials"),
  learningOutcomes: learningOutcomesSchema,
  topics: topicsSchema,
  // The session roadmap the editor's roadmap slot authors. Absent here, the
  // resolver stripped it and every save sent an empty list, which the PUT
  // treats as "replace with nothing" — wiping the roadmap.
  subscriptionContents: z
    .array(SubscriptionContentSchema)
    .default([])
    .refine((contents: z.infer<typeof SubscriptionContentSchema>[]) => {
      const titles = contents.map((c) => c.title.trim().toLowerCase());
      return new Set(titles).size === titles.length;
    }, "Roadmap sessions must have unique titles"),
  status: offeringPlanStatusSchema,
  ...recordingShape,
  ...planPositioningShape,
});

export const maxParticipantsSchema = z
  .number()
  .int("Participants must be a whole number")
  .min(1, "At least one participant is required")
  .max(
    MAX_GROUP_SESSION_PARTICIPANTS,
    `Cannot exceed ${MAX_GROUP_SESSION_PARTICIPANTS} participants`,
  );

// Base schema for common fields
const BaseEventPlanSchema = z.object({
  // Kept through the editor's resolver so an edit PATCHes instead of POSTing.
  id: z.string().optional(),
  title: planTitleSchema,
  description: requiredDescriptionSchema,
  price: priceSchema,
  priceCurrency: z.nativeEnum(Currency).default(Currency.INR),
  maxParticipants: maxParticipantsSchema,
  language: z
    .string()
    .min(1, "Language is required")
    .default("English")
    .refine(
      meaningfulContentRefinement,
      "Language contains nonsensical text or gibberish",
    )
    .refine(
      profanityFreeRefinement,
      "Language contains inappropriate language",
    ),
  level: planLevelSchema,
  prerequisites: optionalFreeText("Prerequisites"),
  materialProvided: optionalFreeText("Materials"),
  learningOutcomes: learningOutcomesSchema,
  topics: topicsSchema,

  // Make consultant fields optional and nullable
  consultantProfileId: z.string().optional().nullable(),
  consultantProfile: z.any().optional().nullable(),

  ...planPositioningShape,
});

// The sold-out "Notify me" list; null caps it at MAX_GROUP_SESSION_PARTICIPANTS.
const waitlistShape = {
  waitlistEnabled: z.boolean().default(true),
  waitlistMax: z
    .number()
    .int("The waitlist size must be a whole number")
    .min(1, "The waitlist must hold at least one person")
    .max(
      MAX_GROUP_SESSION_PARTICIPANTS,
      `The waitlist cannot hold more than ${MAX_GROUP_SESSION_PARTICIPANTS} people`,
    )
    .nullable()
    .optional(),
};

// Webinar specific schema
export const WebinarPlanSchema = BaseEventPlanSchema.extend({
  certificateProvided: z.boolean().default(false),
  ...waitlistShape,
  ...recordingShape,
  shareRecordingsWithAllAttendees: z.boolean().default(false),
  durationInHours: z
    .number()
    .min(0.5, "Duration must be at least 30 minutes")
    .max(8, "Duration cannot exceed 8 hours")
    .refine(
      (val) => (val * 60) % 30 === 0,
      "Duration must be in 30-minute increments",
    ),
  scheduledAt: z
    .string()
    .min(1, "Start time is required")
    .refine(
      (value) => isOnEventLattice(new Date(value)),
      "Pick a start time from the list.",
    ),
});

export const ClassPlanSchema = BaseEventPlanSchema.extend({
  planType: z.literal("class"),
  // Bounds mirror SubscriptionPlanSchema. They were absent here, so a class
  // could be authored at 999 months × 500 sessions/week — and `totalSessions`
  // / `totalHours` are derived from both, which fed the allocation engine.
  durationInMonths: z
    .number()
    .min(1, "Duration must be at least 1 month")
    .max(24, "Duration cannot exceed 24 months"),
  // #1071 — planner CRUD now expands each session into N×30min atoms via
  // `getSlotsPerCall` (= ceil(hours/0.5)). WebinarPlan already refined to
  // 30-minute steps; ClassPlan only had min/max, so a 0.75h class silently
  // became 2×30 = 60min on the consultant's calendar. Reject at the schema
  // rather than clamping the last atom (non-30 ends break allocator parity).
  sessionDurationInHours: z
    .number()
    .min(0.5, "Session duration must be at least 30 minutes")
    .max(4, "Session duration cannot exceed 4 hours")
    .refine(
      (val) => (val * 60) % 30 === 0,
      "Session duration must be in 30-minute increments",
    )
    .default(1),
  certificateProvided: z.boolean().default(false),
  ...waitlistShape,
  ...recordingShape,
  sessionsPerWeek: sessionsPerWeekSchema,
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
  // Named for the manifest field that authors it. It was `startDate` here and
  // `schedulingStartDate` on the form, so the resolver stripped the value and
  // no class ever sent a start date to the API.
  schedulingStartDate: z.date().optional().nullable(),
  endDate: z.date().optional().nullable(),
  // #1819 — empty means "until session 1"; the route caps it at totalSessions.
  lateJoinUntilSession: z
    .number()
    .int("Choose a whole session number")
    .min(1, "Choose session 1 or later")
    .nullable()
    .optional(),
  lateJoinersGetPastRecordings: z.boolean().default(false),
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
