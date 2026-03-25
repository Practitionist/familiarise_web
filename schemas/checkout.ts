import { z } from "zod";
import { AppointmentsType, PaymentGateway } from "@prisma/client";
import { validateSlotTiming } from "@/lib/payments/utils/slot-validation";

// Base schemas for individual components
export const appointmentTypeSchema = z.enum([
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
]);

export const paymentGatewaySchema = z.enum([
  "STRIPE",
  "RAZORPAY",
  "LEMON_SQUEEZY",
  "XFLOW",
  "CARD",
]);

// Search params validation (URL query parameters)
export const searchParamsSchema = z.object({
  slotOfAvailabilityWeeklyId: z.string().optional(),
  slotOfAvailabilityCustomId: z.string().optional(),
  slotStartTimeInUTC: z.string().datetime().optional(),
  slotEndTimeInUTC: z.string().datetime().optional(),
  discountCode: z.string().optional(),
  eventId: z.string().optional(),
  notes: z.string().optional(),
});

// Consultation-specific validation
export const consultationSearchParamsSchema = searchParamsSchema
  .extend({
    slotStartTimeInUTC: z.string().datetime(),
    slotEndTimeInUTC: z.string().datetime(),
  })
  .refine(
    (data) =>
      (data.slotOfAvailabilityWeeklyId && !data.slotOfAvailabilityCustomId) ||
      (!data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message:
        "Exactly one of slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine(
    (data) =>
      new Date(data.slotStartTimeInUTC) < new Date(data.slotEndTimeInUTC),
    {
      message: "Start time must be before end time",
      path: ["slotStartTimeInUTC"],
    },
  );

// Subscription-specific validation
export const subscriptionSearchParamsSchema = searchParamsSchema.extend({
  schedulingPeriodStartsAt: z.string().datetime().optional(),
  schedulingPeriodEndsAt: z.string().datetime().optional(),
});

// Webinar-specific validation
export const webinarSearchParamsSchema = searchParamsSchema.extend({
  eventId: z.string(),
});

// Class-specific validation
export const classSearchParamsSchema = searchParamsSchema.extend({
  eventId: z.string(),
});

// Main checkout schema (for API requests)
export const checkoutSchema = z
  .object({
    appointmentType: appointmentTypeSchema,
    planId: z.string(),
    eventId: z.string().optional(),
    slotStartTimeInUTC: z.string().datetime().optional(),
    slotEndTimeInUTC: z.string().datetime().optional(),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    schedulingPeriodStartsAt: z.string().datetime().optional(),
    schedulingPeriodEndsAt: z.string().datetime().optional(),
    discountCode: z.string().optional(),
    paymentGateway: paymentGatewaySchema.default("RAZORPAY"), // Server auto-routes; client hint only
    displayCurrency: z.string().length(3).optional(), // Currency shown in the checkout UI
    notes: z.string().optional(),
    fromWaitlist: z.string().optional(), // Waitlist ID if coming from waitlist flow
    useReferralCredits: z.boolean().optional(), // Apply available referral credits
  })
  .superRefine((data, ctx) => {
    // === CONSULTATION validation ===
    if (data.appointmentType === "CONSULTATION") {
      // Require slot timing
      if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Consultation requires slot start and end times",
          path: ["slotStartTimeInUTC"],
        });
      }

      // Require slot availability ID
      if (
        !data.slotOfAvailabilityWeeklyId &&
        !data.slotOfAvailabilityCustomId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Consultation requires slot availability ID",
          path: ["slotOfAvailabilityWeeklyId"],
        });
      }
    }

    // === SUBSCRIPTION validation ===
    if (data.appointmentType === "SUBSCRIPTION") {
      const hasSlotData = data.slotStartTimeInUTC && data.slotEndTimeInUTC;
      const hasSchedulingPeriod =
        data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

      // Require EITHER slot data OR scheduling period
      if (!hasSlotData && !hasSchedulingPeriod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Subscription requires either slot timing or scheduling period",
          path: ["slotStartTimeInUTC"],
        });
      }

      // If slot data provided, require availability ID
      if (
        hasSlotData &&
        !data.slotOfAvailabilityWeeklyId &&
        !data.slotOfAvailabilityCustomId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Subscription with slots requires slot availability ID",
          path: ["slotOfAvailabilityWeeklyId"],
        });
      }
    }

    // === WEBINAR and CLASS validation ===
    if (["WEBINAR", "CLASS"].includes(data.appointmentType)) {
      if (!data.eventId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${data.appointmentType.toLowerCase()} requires event ID`,
          path: ["eventId"],
        });
      }
    }

    // === Cross-field validation ===

    // Ensure only one type of slot availability ID
    if (data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot provide both weekly and custom slot availability IDs",
        path: ["slotOfAvailabilityCustomId"],
      });
    }

    // Validate slot timing order if both provided
    if (data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
      const startTime = new Date(data.slotStartTimeInUTC);
      const endTime = new Date(data.slotEndTimeInUTC);
      if (startTime >= endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Start time must be before end time",
          path: ["slotEndTimeInUTC"],
        });
      }
    }

    // Validate slot is not in the past or within minimum booking lead time
    if (data.slotStartTimeInUTC) {
      const slotStart = new Date(data.slotStartTimeInUTC);
      const timingError = validateSlotTiming(slotStart);
      if (timingError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: timingError,
          path: ["slotStartTimeInUTC"],
        });
      }
    }

    // Validate scheduling period order if both provided
    if (data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt) {
      const startDate = new Date(data.schedulingPeriodStartsAt);
      const endDate = new Date(data.schedulingPeriodEndsAt);
      if (startDate >= endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Scheduling period start must be before end",
          path: ["schedulingPeriodEndsAt"],
        });
      }
    }
  });

// Payment intent metadata schema
export const paymentMetadataSchema = z
  .object({
    appointmentId: z.string(),
    appointmentType: z.string(),
  })
  .and(z.record(z.string()));

// Response schemas
export const checkoutSuccessResponseSchema = z.object({
  success: z.literal(true),
  appointmentId: z.string().optional(), // Optional for production flow
  paymentIntentId: z.string().optional(),
  clientSecret: z.string().optional(),
  orderId: z.string().optional(),
  checkoutUrl: z.string().optional(),
  message: z.string().optional(),
  skipPayment: z.boolean().optional(),
  isMockPayment: z.boolean().optional(), // Mock payment flag
  // Production flow fields
  paymentIntent: z
    .object({
      id: z.string(),
      client_secret: z.string().optional(), // Can be Payment Intent secret or Checkout URL
    })
    .optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
});

export const checkoutErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  errorType: z.string().optional(),
  details: z.any().optional(),
});

export const checkoutResponseSchema = z.union([
  checkoutSuccessResponseSchema,
  checkoutErrorResponseSchema,
]);

// Type exports for use in components
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type SearchParams = z.infer<typeof searchParamsSchema>;
export type ConsultationSearchParams = z.infer<
  typeof consultationSearchParamsSchema
>;
export type SubscriptionSearchParams = z.infer<
  typeof subscriptionSearchParamsSchema
>;
export type WebinarSearchParams = z.infer<typeof webinarSearchParamsSchema>;
export type ClassSearchParams = z.infer<typeof classSearchParamsSchema>;
export type PaymentMetadata = z.infer<typeof paymentMetadataSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type CheckoutSuccessResponse = z.infer<
  typeof checkoutSuccessResponseSchema
>;
export type CheckoutErrorResponse = z.infer<typeof checkoutErrorResponseSchema>;

// Utility functions for validation
export const validateSearchParamsForAppointmentType = (
  appointmentType: AppointmentsType,
  searchParams: Record<string, string | undefined>,
) => {
  switch (appointmentType) {
    case "CONSULTATION":
      return consultationSearchParamsSchema.safeParse(searchParams);
    case "SUBSCRIPTION":
      return subscriptionSearchParamsSchema.safeParse(searchParams);
    case "WEBINAR":
      return webinarSearchParamsSchema.safeParse(searchParams);
    case "CLASS":
      return classSearchParamsSchema.safeParse(searchParams);
    default:
      return {
        success: false,
        error: { issues: [{ message: "Invalid appointment type" }] },
      };
  }
};

export const createCheckoutData = (params: {
  appointmentType: AppointmentsType;
  planId: string;
  paymentGateway: PaymentGateway;
  eventId?: string;
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  slotOfAvailabilityWeeklyId?: string;
  slotOfAvailabilityCustomId?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  discountCode?: string;
  displayCurrency?: string;
  notes?: string;
  fromWaitlist?: string;
  useReferralCredits?: boolean;
}): CheckoutInput => {
  return {
    appointmentType: params.appointmentType,
    planId: params.planId,
    paymentGateway: params.paymentGateway,
    eventId: params.eventId,
    slotStartTimeInUTC: params.slotStartTimeInUTC,
    slotEndTimeInUTC: params.slotEndTimeInUTC,
    slotOfAvailabilityWeeklyId: params.slotOfAvailabilityWeeklyId,
    slotOfAvailabilityCustomId: params.slotOfAvailabilityCustomId,
    schedulingPeriodStartsAt: params.schedulingPeriodStartsAt,
    schedulingPeriodEndsAt: params.schedulingPeriodEndsAt,
    discountCode: params.discountCode,
    displayCurrency: params.displayCurrency?.toUpperCase(),
    notes: params.notes,
    fromWaitlist: params.fromWaitlist,
    useReferralCredits: params.useReferralCredits,
  };
};
