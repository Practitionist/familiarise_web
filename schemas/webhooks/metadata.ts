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
});

/**
 * Consultation metadata schema
 * Requires planId and slot times
 */
export const consultationMetadataSchema = baseMetadataSchema.extend({
  appointmentType: z.literal(AppointmentsType.CONSULTATION),
  planId: z.string().cuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

/**
 * Subscription metadata schema
 * Requires planId and either direct slots OR scheduling period
 */
export const subscriptionMetadataSchema = baseMetadataSchema
  .extend({
    appointmentType: z.literal(AppointmentsType.SUBSCRIPTION),
    planId: z.string().cuid(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    schedulingPeriodStartsAt: z.string().datetime().optional(),
    schedulingPeriodEndsAt: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      const hasDirectSlots = data.startsAt && data.endsAt;
      const hasSchedulingPeriod =
        data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;
      return hasDirectSlots || hasSchedulingPeriod;
    },
    {
      message:
        "Must provide either direct slots (startsAt/endsAt) OR scheduling period (schedulingPeriodStartsAt/schedulingPeriodEndsAt)",
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
 * Trial metadata schema
 *
 * A paid trial's appointment already exists when the intent is created (the
 * consultant accepted and the slot is held), so `trialId` is what the handler
 * needs to move the session out of AWAITING_PAYMENT. `planId` is the parent
 * subscription plan the trial belongs to.
 *
 * Without this arm the switch below threw "Unsupported appointment type", which
 * routes to CRITICAL_PAYMENT_WITHOUT_APPOINTMENT — the learner charged and the
 * trial never scheduled.
 */
export const trialMetadataSchema = baseMetadataSchema.extend({
  appointmentType: z.literal(AppointmentsType.TRIAL),
  planId: z.string().cuid(),
  trialId: z.string().cuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

/**
 * #679 transition dual-read — REMOVE after 2026-07-12.
 *
 * Razorpay persists checkout metadata as order `notes`; orders created
 * before the startsAt/endsAt rename deployed replay their webhooks with the
 * LEGACY keys (`slotStartTimeInUTC`/`slotEndTimeInUTC`). Failing validation
 * for those would strand real captured payments as
 * CRITICAL_PAYMENT_WITHOUT_APPOINTMENT. Orders expire in minutes, but late
 * captures and webhook redelivery stretch the tail — one month is
 * conservative. This maps old keys onto the new names when the new ones are
 * absent; it is wire-format compatibility for persisted external data, not
 * a code alias.
 */
export function normalizeLegacySlotKeys(
  metadata: Record<string, string>,
): Record<string, string> {
  const out = { ...metadata };
  if (out.slotStartTimeInUTC && !out.startsAt) {
    out.startsAt = out.slotStartTimeInUTC;
  }
  if (out.slotEndTimeInUTC && !out.endsAt) {
    out.endsAt = out.slotEndTimeInUTC;
  }
  delete out.slotStartTimeInUTC;
  delete out.slotEndTimeInUTC;
  return out;
}

/**
 * Validate webhook metadata based on appointment type
 *
 * @param metadata - Metadata from payment gateway webhook
 * @returns Parsed and validated metadata
 * @throws ZodError if validation fails
 */
export function validateWebhookMetadata(rawMetadata: Record<string, string>) {
  const metadata = normalizeLegacySlotKeys(rawMetadata);
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
    case AppointmentsType.TRIAL:
      return trialMetadataSchema.parse(metadata);
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }
}
