import { z } from "zod";

export const subscriptionCheckoutSchema = z.object({
  subscriptionPlanId: z.string(),
  discountCode: z.string().optional(),
});

export type SubscriptionCheckoutInput = z.infer<
  typeof subscriptionCheckoutSchema
>;

// Common types for subscription checkout
export interface SubscriptionPlanWithDetails {
  id: string;
  title: string;
  price: number;
  durationInMonths: number;
  consultantProfile: {
    user?: {
      id: string;
      name: string | null;
      email: string | null;
    } | null;
  };
}

export interface SubscriptionCheckoutMetadata {
  payment_id: string;
  subscription_id: string;
  appointment_id: string;
  user_id: string;
}

export interface SubscriptionProductDetails {
  name: string;
  description: string;
  durationInMonths: number;
}

export interface SubscriptionCheckoutUrls {
  success: string;
  cancel: string;
}
