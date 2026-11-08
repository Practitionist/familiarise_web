/**
 * Per-type wiring for the offering editor.
 *
 * Everything that genuinely differs between the four types — which Zod schema
 * validates it, what an empty one looks like, how to read an existing one, and
 * which service saves it — is declared once here. The editor itself stays
 * type-agnostic, so a new offering type is a manifest plus an adapter rather
 * than another 900-line dialog.
 */

import { z, type ZodTypeAny } from "zod";
import {
  ClassPlanSchema,
  ConsultationPlanSchema,
  SubscriptionPlanSchema,
  WebinarPlanSchema,
} from "@/schemas/plans";
import { DigitalProductCategory, PlanLevel } from "@prisma/client";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE } from "@/lib/digital-products/constants";
import { DIGITAL_PRODUCT_PRICE_RULE } from "@/schemas/digital-products";
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

/**
 * The date control writes a Date; the class endpoint takes an ISO string.
 * Three outcomes matter for PATCH:
 *   - ISO string → set the date
 *   - null → clear an existing date (JSON keeps the key)
 *   - undefined → omit the field so the route leaves the column alone
 * Returning undefined for a cleared field used to drop the key from
 * JSON.stringify, so clearing the editor never reached the API.
 */
const toIsoDate = (value: unknown): string | null | undefined => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value) return value;
  if (value === null || value === "") return null;
  return undefined;
};

/** Which group-event instance a save addresses, and its current status. */
export interface OfferingSaveContext {
  instanceId?: string;
  instanceStatus?: string | null;
  /** False when the capacity equals what the editor loaded; the update then omits it. */
  capacityEdited?: boolean;
}

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
    ctx?: OfferingSaveContext,
  ) => Promise<unknown>;
}

/**
 * The GET returns `topics` as the `Topic` relation (`{ id, name, ... }`), but
 * the form's `stringList` field and the save schema both hold names.
 */
const topicNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : typeof (item as { name?: unknown })?.name === "string"
          ? (item as { name: string }).name
          : "",
    )
    .filter((name) => name !== "");
};

/**
 * The API returns `price` in paise (#780 money model) while the form edits
 * rupees — same convention as every other price field in the product. Each
 * adapter's `planOf` divides on the way IN; the services multiply on the way
 * OUT. Everything else passes through untouched.
 */
const toFormValues = (
  plan: Record<string, unknown>,
): Record<string, unknown> => {
  const rawPrerequisites = plan.prerequisites ?? plan.prerequisite;
  const rawMaterial = plan.materialProvided ?? plan.material;
  const rawOutcomes = Array.isArray(plan.learningOutcomes)
    ? plan.learningOutcomes
    : [];
  const rawDeliverables = Array.isArray(plan.deliverables)
    ? plan.deliverables
    : [];
  const rawWhatsIncluded = Array.isArray(plan.whatsIncluded)
    ? plan.whatsIncluded
    : [];
  return {
    ...plan,
    subtitle: typeof plan.subtitle === "string" ? plan.subtitle : "",
    description: typeof plan.description === "string" ? plan.description : "",
    prerequisites: typeof rawPrerequisites === "string" ? rawPrerequisites : "",
    materialProvided: typeof rawMaterial === "string" ? rawMaterial : "",
    learningOutcomes: rawOutcomes.length > 0 ? rawOutcomes : rawDeliverables,
    whatsIncluded:
      rawWhatsIncluded.length > 0 ? rawWhatsIncluded : rawDeliverables,
    targetAudience: Array.isArray(plan.targetAudience)
      ? plan.targetAudience
      : [],
    price: typeof plan.price === "number" ? plan.price / 100 : plan.price,
    topics: topicNames(plan.topics),
  };
};

/**
 * #1527 Q4 — the container speaks the webinar/class vocabulary (SCHEDULED or
 * DRAFT); 1:1 and subscription plans store PUBLISHED or DRAFT.
 */
/**
 * #1527 — webinar/class drafts live on the instance. A create takes the
 * status as sent; an update moves only a DRAFT instance, because publishing
 * is one-way (EVENT_PUBLISHABLE_FROM) and a published event never goes back.
 */
const eventStatus = (
  values: Record<string, unknown>,
  ctx: OfferingSaveContext | undefined,
): { status?: "DRAFT" | "SCHEDULED" } => {
  const status = values.status === "DRAFT" ? "DRAFT" : "SCHEDULED";
  const isUpdate = typeof values.id === "string" && values.id !== "";
  return !isUpdate || ctx?.instanceStatus === "DRAFT" ? { status } : {};
};

/** An update with an untouched capacity sends none, so a stale load cannot move it. */
export const withoutUntouchedCapacity = (
  values: Record<string, unknown>,
  ctx: OfferingSaveContext | undefined,
): Record<string, unknown> => {
  if (ctx?.capacityEdited !== false) return values;
  const { maxParticipants: _untouched, ...rest } = values;
  return rest;
};

/** Copies carry no row ids, so saving one creates fresh plan children. */
const withoutIds = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((item) => {
        if (!item || typeof item !== "object") return item;
        const { id: _id, ...rest } = item as Record<string, unknown>;
        return rest;
      })
    : value;

/**
 * #1527 §7.2 Duplicate — the source's form values as a new, unsaved offering:
 * no id, a "Copy of" title, and no session date (a copy must be scheduled
 * afresh).
 */
export function duplicateFormValues(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const {
    id: _id,
    status: _status,
    scheduledAt: _scheduledAt,
    schedulingStartDate: _start,
    ...rest
  } = plan;
  return {
    ...rest,
    title: `Copy of ${String(plan.title ?? "")}`.trim(),
    faqs: withoutIds(plan.faqs),
    classContents: withoutIds(plan.classContents),
    subscriptionContents: withoutIds(plan.subscriptionContents),
  };
}

const withPlanStatus = (
  values: Record<string, unknown>,
): Record<string, unknown> => ({
  ...values,
  status: values.status === "DRAFT" ? "DRAFT" : "PUBLISHED",
});

export const OFFERING_ADAPTERS: Record<OfferingType, OfferingAdapter> = {
  consultation: {
    schema: ConsultationPlanSchema,
    imageType: "consultation-plans",
    defaults: {
      ...sharedDefaults,
      durationInHours: 1,
      recordingEnabled: false,
    },
    planOf: (event) => {
      const plan = (event as { consultationPlan?: Record<string, unknown> })
        ?.consultationPlan;
      return plan ? toFormValues(plan) : undefined;
    },
    save: (values, consultantId) =>
      ConsultationService.saveConsultationPlan(
        { consultationPlan: withPlanStatus(values) } as never,
        consultantId,
      ),
  },

  subscription: {
    schema: SubscriptionPlanSchema,
    imageType: "subscription-plans",
    defaults: {
      ...sharedDefaults,
      // New plans are sold in weeks; months follow from them.
      durationInWeeks: 4,
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      emailSupport: "GENERAL",
      subscriptionContents: [],
      recordingEnabled: false,
      trialEnabled: false,
      trialDurationMinutes: 30,
      trialPriceInPaise: 0,
    },
    planOf: (event) => {
      const plan = (event as { subscriptionPlan?: Record<string, unknown> })
        ?.subscriptionPlan;
      if (!plan) return undefined;
      // The trial price is edited in rupees like `price`; the service converts back.
      const trialPaise = plan.trialPriceInPaise;
      let sessionsPerWeek = 1;
      if (typeof plan.sessionsPerWeek === "number") {
        sessionsPerWeek = plan.sessionsPerWeek;
      } else if (typeof plan.callsPerWeek === "number") {
        sessionsPerWeek = plan.callsPerWeek;
      }
      const sessionDurationInHours =
        typeof plan.sessionDurationInHours === "number" &&
        plan.sessionDurationInHours > 0
          ? plan.sessionDurationInHours
          : 1;
      return {
        ...toFormValues(plan),
        sessionsPerWeek,
        sessionDurationInHours,
        trialPriceInPaise:
          typeof trialPaise === "number" ? trialPaise / 100 : trialPaise,
      };
    },
    save: (values, consultantId) =>
      SubscriptionService.saveSubscriptionPlan(
        { subscriptionPlan: withPlanStatus(values) } as never,
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
      waitlistEnabled: true,
      waitlistMax: null,
      recordingEnabled: false,
      shareRecordingsWithAllAttendees: false,
    },
    planOf: (event) => {
      const plan = (event as { webinarPlan?: Record<string, unknown> })
        ?.webinarPlan;
      return plan ? toFormValues(plan) : undefined;
    },
    save: (values, consultantId, ctx) =>
      WebinarService.saveWebinar(
        {
          id: ctx?.instanceId,
          ...eventStatus(values, ctx),
          webinarPlan: withoutUntouchedCapacity(values, ctx),
        } as never,
        (values.scheduledAt as string | Date | null) ?? null,
        consultantId,
      ),
  },

  class: {
    schema: ClassPlanSchema,
    imageType: "class-plans",
    defaults: {
      ...sharedDefaults,
      // ClassPlanSchema's discriminator; no plan row carries it, so it lives here.
      planType: "class",
      durationInMonths: 1,
      sessionsPerWeek: 1,
      // Exposed as a real field now. The dialog hardcoded 1 and never rendered
      // it, so every class was a one-hour-session class.
      sessionDurationInHours: 1,
      maxParticipants: 30,
      emailSupport: "GENERAL",
      certificateProvided: false,
      waitlistEnabled: true,
      waitlistMax: null,
      recordingEnabled: false,
      classContents: [],
      schedulingStartDate: null,
      lateJoinUntilSession: null,
      lateJoinersGetPastRecordings: false,
    },
    // A class's start date is authored on the plan form but persisted on the
    // Class row as `schedulingPeriodStartsAt`, so it is lifted into the form
    // values here and mapped back to the API's `startDate` on save.
    planOf: (event) => {
      const wrapper = event as {
        classPlan?: Record<string, unknown>;
        schedulingPeriodStartsAt?: string | Date | null;
      };
      if (!wrapper?.classPlan) return undefined;
      return {
        ...toFormValues(wrapper.classPlan),
        schedulingStartDate: wrapper.schedulingPeriodStartsAt
          ? new Date(wrapper.schedulingPeriodStartsAt)
          : null,
      };
    },
    save: (values, consultantId, ctx) =>
      ClassService.saveClass(
        {
          id: ctx?.instanceId,
          ...eventStatus(values, ctx),
          classPlan: withoutUntouchedCapacity(values, ctx),
        } as never,
        consultantId,
        toIsoDate(values.schedulingStartDate),
      ),
  },
};

/** The digital product form; the price is edited in rupees and sent as paise. */
export const digitalProductFormSchema = z.object({
  title: z.string().trim().min(3, "At least 3 characters").max(120),
  subtitle: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().min(10, "At least 10 characters").max(10_000),
  category: z.nativeEnum(DigitalProductCategory),
  price: z
    .number()
    .min(0)
    .max(500_000, "At most ₹5,00,000")
    .refine(
      (rupees) =>
        rupees === 0 ||
        Math.round(rupees * 100) >= DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE,
      DIGITAL_PRODUCT_PRICE_RULE,
    ),
  priceCurrency: z.literal("INR"),
  // Written by the cover-image route, never by the form's save.
  coverImagePath: z.string().nullable().optional(),
});
export type DigitalProductFormValues = z.infer<typeof digitalProductFormSchema>;

export const DIGITAL_PRODUCT_DEFAULTS: DigitalProductFormValues = {
  title: "",
  subtitle: "",
  description: "",
  category: DigitalProductCategory.DOCUMENT,
  price: 0,
  priceCurrency: "INR",
  coverImagePath: null,
};

async function productRequest(
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(body, fallback));
  return body;
}

const savedProductSchema = z.object({ data: z.object({ id: z.string() }) });

/** Create the product, or update the listing of `productId`; returns its id. */
export async function saveDigitalProduct(
  values: DigitalProductFormValues,
  productId?: string,
): Promise<string> {
  const listing = {
    title: values.title,
    subtitle: values.subtitle?.trim() || null,
    description: values.description,
    category: values.category,
    pricePaise: Math.round(values.price * 100),
  };
  const body = await productRequest(
    productId
      ? `/api/digital-products/${encodeURIComponent(productId)}`
      : "/api/digital-products",
    { method: productId ? "PATCH" : "POST", body: JSON.stringify(listing) },
    "Couldn't save the product",
  );
  return savedProductSchema.parse(body).data.id;
}

/** Put the product on sale, or take it off sale; buyers keep their access. */
export async function setDigitalProductLifecycle(
  productId: string,
  action: "publish" | "archive",
): Promise<void> {
  await productRequest(
    `/api/digital-products/${encodeURIComponent(productId)}/${action}`,
    { method: "POST" },
    action === "publish"
      ? "Couldn't publish the product"
      : "Couldn't take the product off sale",
  );
}
