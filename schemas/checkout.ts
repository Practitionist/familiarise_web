import { z } from "zod";
import { AppointmentsType, PaymentGateway } from "@prisma/client";

// Base schemas for individual components
export const appointmentTypeSchema = z.enum([
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
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
    discountCode: z.string().optional(),
    paymentGateway: paymentGatewaySchema,
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      // For consultation and subscription, require slot timing
      if (["CONSULTATION", "SUBSCRIPTION"].includes(data.appointmentType)) {
        return data.slotStartTimeInUTC && data.slotEndTimeInUTC;
      }
      return true;
    },
    {
      message: "Consultation and subscription appointments require slot timing",
      path: ["slotStartTimeInUTC"],
    },
  )
  .refine(
    (data) => {
      // For consultation and subscription, require slot availability ID
      if (data.appointmentType === "CONSULTATION") {
        return (
          !!data.slotOfAvailabilityWeeklyId || !!data.slotOfAvailabilityCustomId
        );
      }
      return true;
    },
    {
      message:
        "Consultation appointments require slot availability ID",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine(
    (data) => {
      // For webinar and class, require event ID
      if (["WEBINAR", "CLASS"].includes(data.appointmentType)) {
        return data.eventId;
      }
      return true;
    },
    {
      message: "Webinar and class appointments require event ID",
      path: ["eventId"],
    },
  )
  .refine(
    (data) => {
      // Ensure only one slot availability ID is provided
      if (data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId) {
        return false;
      }
      return true;
    },
    {
      message: "Cannot provide both weekly and custom slot availability IDs",
      path: ["slotOfAvailabilityCustomId"],
    },
  )
  .refine(
    (data) => {
      // Validate slot timing if provided
      if (data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
        return (
          new Date(data.slotStartTimeInUTC) < new Date(data.slotEndTimeInUTC)
        );
      }
      return true;
    },
    {
      message: "Start time must be before end time",
      path: ["slotEndTimeInUTC"],
    },
  );

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
  discountCode?: string;
  notes?: string;
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
    discountCode: params.discountCode,
    notes: params.notes,
  };
};
