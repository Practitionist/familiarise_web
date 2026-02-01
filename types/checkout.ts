import { AppointmentsType, PaymentGateway } from "@prisma/client";

/**
 * Discount applied to a checkout session.
 * Shared across all 4 checkout pages (consultation, subscription, webinar, class).
 */
export interface AppliedDiscount {
  code: string;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: number;
  discountAmount?: number;
}

export interface CheckoutSession {
  id: string;
  slotId: string;
  appointmentType: AppointmentsType;
  planId: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";
  expiresAt: Date;
  paymentIntentId?: string;
}

export interface PaymentMetadata {
  appointmentId: string;
  appointmentType: AppointmentsType;
  userId: string;
  [key: string]: string;
}

export interface PaymentWebhookEvent {
  type: string;
  metadata: PaymentMetadata;
}

export interface PaymentIntentParams {
  amount: number;
  currency: string;
  metadata: PaymentMetadata;
  paymentGateway: PaymentGateway;
}

export interface PaymentIntent {
  id: string;
  client_secret: string;
  amount: number;
  currency: string;
  status: string;
}
