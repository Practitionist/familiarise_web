/**
 * Per-type wiring for the offering editor.
 *
 * Everything that genuinely differs between the four types — which Zod schema
 * validates it, what an empty one looks like, how to read an existing one, and
 * which service saves it — is declared once here. The editor itself stays
 * type-agnostic, so a new offering type is a manifest plus an adapter rather
 * than another 900-line dialog.
 */

import type { ZodTypeAny } from "zod";
import {
  ClassPlanSchema,
  ConsultationPlanSchema,
  SubscriptionPlanSchema,
  WebinarPlanSchema,
} from "@/schemas/plans";
import { PlanLevel } from "@prisma/client";
import type { TPlanImageType } from "@/lib/supabase";
import { ConsultationService } from "@/components/planner/services/plans/consultation-service";
import { SubscriptionService } from "@/components/planner/services/plans/subscription-service";
import { WebinarService } from "@/components/planner/services/events/webinar-service";
import { ClassService } from "@/components/planner/services/events/class-service";
import type { OfferingType } from "./manifest";

/** Fields every offering shares, so a new type cannot omit them by accident. */
const sharedDefaults = {
  title: "",
  subtitle: "",
  description: "",
  imageUrl: null as string | null,
  price: 0,
  priceCurrency: "INR",
  language: "English",
  level: PlanLevel.BEGINNER,
  prerequisites: "",
  materialProvided: "",
  learningOutcomes: [] as string[],
  topics: [] as string[],
  targetAudience: [] as string[],
  whatsIncluded: [] as string[],
  faqs: [] as { question: string; answer: string; order?: number }[],
};

export interface OfferingAdapter {
  schema: ZodTypeAny;
  /** Which bucket the image uploader writes to. */
  imageType: TPlanImageType;
  defaults: Record<string, unknown>;
  /** Pull the plan out of the planner's event wrapper. */
  planOf: (event: unknown) => Record<string, unknown> | undefined;
  /** Save, returning the planner event. Handles create and update alike. */
  save: (
    values: Record<string, unknown>,
    consultantId: string,
  ) => Promise<unknown>;
}

export const OFFERING_ADAPTERS: Record<OfferingType, OfferingAdapter> = {
  consultation: {
    schema: ConsultationPlanSchema,
    imageType: "consultation-plans",
    defaults: { ...sharedDefaults, durationInHours: 1 },
    planOf: (event) =>
      (event as { consultationPlan?: Record<string, unknown> })
        ?.consultationPlan,
    save: (values, consultantId) =>
      ConsultationService.saveConsultationPlan(
        { consultationPlan: values } as never,
        consultantId,
      ),
  },

  subscription: {
    schema: SubscriptionPlanSchema,
    imageType: "subscription-plans",
    defaults: {
      ...sharedDefaults,
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      emailSupport: "GENERAL",
      subscriptionContents: [],
    },
    planOf: (event) =>
      (event as { subscriptionPlan?: Record<string, unknown> })
        ?.subscriptionPlan,
    save: (values, consultantId) =>
      SubscriptionService.saveSubscriptionPlan(
        { subscriptionPlan: values } as never,
        consultantId,
      ),
  },

  webinar: {
    // The dialog validated against a locally-declared schema instead of the
    // exported one, so webinar rules could drift from the API's without anyone
    // noticing. This uses the exported schema the endpoint itself parses.
    schema: WebinarPlanSchema,
    imageType: "webinar-plans",
    defaults: {
      ...sharedDefaults,
      durationInHours: 1,
      maxParticipants: 100,
      certificateProvided: false,
      recordingEnabled: false,
    },
    planOf: (event) =>
      (event as { webinarPlan?: Record<string, unknown> })?.webinarPlan,
    save: (values, consultantId) =>
      WebinarService.saveWebinar(
        { webinarPlan: values } as never,
        (values.scheduledAt as string | Date | null) ?? null,
        consultantId,
      ),
  },

  class: {
    schema: ClassPlanSchema,
    imageType: "class-plans",
    defaults: {
      ...sharedDefaults,
      durationInMonths: 1,
      sessionsPerWeek: 1,
      // Exposed as a real field now. The dialog hardcoded 1 and never rendered
      // it, so every class was a one-hour-session class.
      sessionDurationInHours: 1,
      maxParticipants: 30,
      emailSupport: "GENERAL",
      certificateProvided: false,
      recordingEnabled: false,
      classContents: [],
      schedulingStartDate: null,
    },
    planOf: (event) =>
      (event as { classPlan?: Record<string, unknown> })?.classPlan,
    save: (values, consultantId) =>
      ClassService.saveClass({ classPlan: values } as never, consultantId),
  },
};
