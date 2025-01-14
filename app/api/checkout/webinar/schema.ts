import { z } from "zod";

export const webinarCheckoutSchema = z.object({
  webinarPlanId: z.string(),
  discountCode: z.string().optional(),
});

export type WebinarCheckoutInput = z.infer<typeof webinarCheckoutSchema>;

// Common types for webinar checkout
export interface WebinarPlanWithDetails {
  id: string;
  title: string;
  price: number;
  maxParticipants: number;
  durationInHours: number;
  topics: {
    id: string;
    name: string;
  }[];
  consultantProfile?: {
    user?: {
      id: string;
      name: string | null;
      email: string | null;
    } | null;
  } | null;
}

export interface WebinarCheckoutMetadata {
  payment_id: string;
  webinar_id: string;
  appointment_id: string;
  user_id: string;
}

export interface WebinarProductDetails {
  name: string;
  description: string;
  duration: string;
}

export interface WebinarCheckoutUrls {
  success: string;
  cancel: string;
}
