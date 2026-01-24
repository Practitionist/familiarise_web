/**
 * Webhook Metadata Validation Schemas
 *
 * Validates payment gateway webhook metadata to ensure all required fields
 * are present before creating appointments. Prevents "orphaned payments"
 * where payment succeeds but appointment creation fails silently.
 */

import { z } from "zod";
import { AppointmentsType } from "@prisma/client";

/**
 * Base schema shared by all appointment types
 */
const baseMetadataSchema = z.object({
  appointmentType: z.nativeEnum(AppointmentsType),
  userId: z.string().cuid(),
  planId: z.string().optional(),
  eventId: z.string().optional(),
  notes: z.string().optional(),
  fromWaitlist: z.string().cuid().optional(), // Waitlist entry ID if coming from waitlist flow
});

/**
 * Consultation metadata schema
 * Requires planId and slot times
 */
export const consultationMetadataSchema = baseMetadataSchema.extend({
  appointmentType: z.literal(AppointmentsType.CONSULTATION),
  planId: z.string().cuid(),
  slotStartTimeInUTC: z.string().datetime(),
  slotEndTimeInUTC: z.string().datetime(),
});

/**
 * Subscription metadata schema
 * Requires planId and either direct slots OR scheduling period
 */
export const subscriptionMetadataSchema = baseMetadataSchema
  .extend({
    appointmentType: z.literal(AppointmentsType.SUBSCRIPTION),
    planId: z.string().cuid(),
    slotStartTimeInUTC: z.string().datetime().optional(),
    slotEndTimeInUTC: z.string().datetime().optional(),
    schedulingPeriodStartsAt: z.string().datetime().optional(),
    schedulingPeriodEndsAt: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      const hasDirectSlots = data.slotStartTimeInUTC && data.slotEndTimeInUTC;
      const hasSchedulingPeriod =
        data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;
      return hasDirectSlots || hasSchedulingPeriod;
    },
    {
      message:
        "Must provide either direct slots (slotStartTimeInUTC/slotEndTimeInUTC) OR scheduling period (schedulingPeriodStartsAt/schedulingPeriodEndsAt)",
    },
  );

/**
 * Webinar metadata schema
 * Requires eventId (webinar ID)
 */
export const webinarMetadataSchema = baseMetadataSchema.extend({
  appointmentType: z.literal(AppointmentsType.WEBINAR),
  eventId: z.string().cuid(),
});

/**
 * Class metadata schema
 * Requires eventId (class ID)
 */
export const classMetadataSchema = baseMetadataSchema.extend({
  appointmentType: z.literal(AppointmentsType.CLASS),
  eventId: z.string().cuid(),
});

/**
 * Validate webhook metadata based on appointment type
 *
 * @param metadata - Metadata from payment gateway webhook
 * @returns Parsed and validated metadata
 * @throws ZodError if validation fails
 */
export function validateWebhookMetadata(metadata: Record<string, string>) {
  // First parse appointmentType to determine which schema to use
  const { appointmentType } = baseMetadataSchema.parse(metadata);

  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      return consultationMetadataSchema.parse(metadata);
    case AppointmentsType.SUBSCRIPTION:
      return subscriptionMetadataSchema.parse(metadata);
    case AppointmentsType.WEBINAR:
      return webinarMetadataSchema.parse(metadata);
    case AppointmentsType.CLASS:
      return classMetadataSchema.parse(metadata);
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }
}

/**
 * Type exports for validated metadata
 */
export type ConsultationMetadata = z.infer<typeof consultationMetadataSchema>;
export type SubscriptionMetadata = z.infer<typeof subscriptionMetadataSchema>;
export type WebinarMetadata = z.infer<typeof webinarMetadataSchema>;
export type ClassMetadata = z.infer<typeof classMetadataSchema>;
export type ValidatedMetadata =
  | ConsultationMetadata
  | SubscriptionMetadata
  | WebinarMetadata
  | ClassMetadata;
