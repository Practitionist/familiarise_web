import { z } from "zod";

export const ConsultationCheckoutSchema = z
  .object({
    consultationPlanId: z.string().uuid(),
    slotId: z.string().uuid(),
    slotStartTimeInUTC: z.string().datetime(),
    slotEndTimeInUTC: z.string().datetime(),
    paymentGateway: z.enum(["STRIPE", "RAZORPAY"]).default("STRIPE"),
  })
  .refine(
    (data) => {
      const start = new Date(data.slotStartTimeInUTC);
      const end = new Date(data.slotEndTimeInUTC);
      return end > start;
    },
    {
      message: "End time must be after start time",
      path: ["slotEndTimeInUTC"],
    },
  );

export const SubscriptionCheckoutSchema = z.object({
  subscriptionPlanId: z.string().uuid(),
  slotIds: z.array(z.string().uuid()),
  slotTimes: z
    .array(
      z.object({
        slotStartTimeInUTC: z.string().datetime(),
        slotEndTimeInUTC: z.string().datetime(),
      }),
    )
    .refine(
      (slots) => {
        return slots.every((slot) => {
          const start = new Date(slot.slotStartTimeInUTC);
          const end = new Date(slot.slotEndTimeInUTC);
          return end > start;
        });
      },
      {
        message: "End time must be after start time for all slots",
      },
    ),
  paymentGateway: z.enum(["STRIPE", "RAZORPAY"]).default("STRIPE"),
});

export const WebinarCheckoutSchema = z.object({
  webinarId: z.string().uuid(),
  paymentGateway: z.enum(["STRIPE", "RAZORPAY"]).default("STRIPE"),
});

export const ClassCheckoutSchema = z.object({
  classId: z.string().uuid(),
  paymentGateway: z.enum(["STRIPE", "RAZORPAY"]).default("STRIPE"),
});

export type ConsultationCheckoutInput = z.infer<
  typeof ConsultationCheckoutSchema
>;
export type SubscriptionCheckoutInput = z.infer<
  typeof SubscriptionCheckoutSchema
>;
export type WebinarCheckoutInput = z.infer<typeof WebinarCheckoutSchema>;
export type ClassCheckoutInput = z.infer<typeof ClassCheckoutSchema>;
