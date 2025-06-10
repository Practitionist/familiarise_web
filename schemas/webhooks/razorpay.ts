import { z } from "zod";

// Basic entity schemas
const razorpayPaymentEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("payment"),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  order_id: z.string(),
  invoice_id: z.string().nullable(),
  international: z.boolean(),
  method: z.string(),
  amount_refunded: z.number(),
  refund_status: z.string().nullable(),
  captured: z.boolean(),
  description: z.string().nullable(),
  card_id: z.string().nullable(),
  bank: z.string().nullable(),
  wallet: z.string().nullable(),
  vpa: z.string().nullable(),
  email: z.string().email(),
  contact: z.string(),
  notes: z.record(z.string()).optional(),
  fee: z.number().nullable(),
  tax: z.number().nullable(),
  error_code: z.string().nullable(),
  error_description: z.string().nullable(),
  error_source: z.string().nullable(),
  error_step: z.string().nullable(),
  error_reason: z.string().nullable(),
  created_at: z.number(),
});

const razorpayOrderEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("order"),
  amount: z.number(),
  amount_paid: z.number(),
  amount_due: z.number(),
  currency: z.string(),
  receipt: z.string().nullable(),
  offer_id: z.string().nullable(),
  status: z.string(),
  attempts: z.number(),
  notes: z.record(z.string()).optional(),
  created_at: z.number(),
});

// Event payload schemas
const paymentEventPayloadSchema = z.object({
  payment: z.object({
    entity: razorpayPaymentEntitySchema,
  }),
});

const orderEventPayloadSchema = z.object({
  order: z.object({
    entity: razorpayOrderEntitySchema,
  }),
});

// Combined event schemas
export const razorpayPaymentCapturedEventSchema = z.object({
  entity: z.literal("event"),
  account_id: z.string(),
  event: z.literal("payment.captured"),
  contains: z.array(z.string()),
  payload: paymentEventPayloadSchema,
  created_at: z.number(),
});

export const razorpayOrderPaidEventSchema = z.object({
  entity: z.literal("event"),
  account_id: z.string(),
  event: z.literal("order.paid"),
  contains: z.array(z.string()),
  payload: orderEventPayloadSchema,
  created_at: z.number(),
});

export const razorpayPaymentFailedEventSchema = z.object({
  entity: z.literal("event"),
  account_id: z.string(),
  event: z.literal("payment.failed"),
  contains: z.array(z.string()),
  payload: paymentEventPayloadSchema,
  created_at: z.number(),
});

// A generic schema to parse the event type first
export const razorpayBaseEventSchema = z.object({
  event: z.string(),
});

export type RazorpayPaymentCapturedEvent = z.infer<
  typeof razorpayPaymentCapturedEventSchema
>;
export type RazorpayOrderPaidEvent = z.infer<typeof razorpayOrderPaidEventSchema>;
export type RazorpayPaymentFailedEvent = z.infer<
  typeof razorpayPaymentFailedEventSchema
>;
