import { z } from "zod";

export const classCheckoutSchema = z.object({
  classPlanId: z.string(),
  discountCode: z.string().optional(),
});

export type ClassCheckoutInput = z.infer<typeof classCheckoutSchema>;

// Common types for class checkout
export interface ClassPlanWithDetails {
  id: string;
  title: string;
  price: number;
  maxParticipants: number;
  durationInMonths: number;
  callsPerWeek: number;
  videoMeetings: number;
  emailSupport: string;
  certificateProvided: boolean;
  topics: {
    id: string;
    name: string;
  }[];
  classContents: {
    id: string;
    title: string;
    description: string;
    contentType: string | null;
    contentUrl: string | null;
    order: number;
    hoursAllotted: number;
  }[];
  consultantProfile?: {
    user?: {
      id: string;
      name: string | null;
      email: string | null;
    } | null;
  } | null;
}

export interface ClassCheckoutMetadata {
  payment_id: string;
  class_id: string;
  appointment_id: string;
  user_id: string;
}

export interface ClassProductDetails {
  name: string;
  description: string;
  duration: string;
  features: string[];
}

export interface ClassCheckoutUrls {
  success: string;
  cancel: string;
}
