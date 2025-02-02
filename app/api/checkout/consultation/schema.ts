import { z } from "zod";

export const consultationCheckoutSchema = z
  .object({
    consultationPlanId: z.string(),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    slotStartTimeInUTC: z.string().datetime(),
    slotEndTimeInUTC: z.string().datetime(),
    discountCode: z.string().optional(),
  })
  .refine(
    (data) =>
      (data.slotOfAvailabilityWeeklyId && !data.slotOfAvailabilityCustomId) ||
      (!data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message:
        "Exactly one of slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
    },
  )
  .refine(
    (data) =>
      new Date(data.slotStartTimeInUTC) < new Date(data.slotEndTimeInUTC),
    {
      message: "Start time must be before end time",
    },
  );

export type ConsultationCheckoutInput = z.infer<
  typeof consultationCheckoutSchema
>;

// Common types for consultation checkout
export interface ConsultationPlanWithDetails {
  id: string;
  title: string;
  price: number;
  consultantProfile: {
    user?: {
      id: string;
      name: string | null;
      email: string | null;
    } | null;
  };
}

export interface ConsultationCheckoutMetadata {
  payment_id: string;
  consultation_id: string;
  appointment_id: string;
  user_id: string;
}

export interface ConsultationProductDetails {
  name: string;
  description: string;
}

export interface ConsultationCheckoutUrls {
  success: string;
  cancel: string;
}
