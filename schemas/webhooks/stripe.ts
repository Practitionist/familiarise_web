import { z } from "zod";

// Base event schema to get the type
export const stripeBaseEventSchema = z.object({
  id: z.string(),
  object: z.literal("event"),
  api_version: z.string(),
  created: z.number(),
  type: z.string(), // We'll use this to narrow down the event type
  livemode: z.boolean(),
  pending_webhooks: z.number(),
  request: z
    .object({
      id: z.string().nullable(),
      idempotency_key: z.string().nullable(),
    })
    .nullable(),
  data: z.object({
    object: z.any(),
  }),
});

// Metadata schema
const metadataSchema = z.record(z.string()).nullable();

// Payment Intent schema
const paymentIntentSchema = z.object({
  id: z.string(),
  object: z.literal("payment_intent"),
  amount: z.number(),
  amount_received: z.number().nullable().optional(),
  currency: z.string(),
  metadata: metadataSchema,
  status: z.string(),
  last_payment_error: z
    .object({
      code: z.string().nullable(),
      doc_url: z.string().nullable(),
      message: z.string().nullable(),
      param: z.string().nullable(),
      type: z.string(),
    })
    .nullable(),
});

// Payment Intent Succeeded event
export const stripePaymentIntentSucceededEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("payment_intent.succeeded"),
    data: z.object({
      object: paymentIntentSchema,
    }),
  });

// Payment Intent Failed event
export const stripePaymentIntentFailedEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("payment_intent.payment_failed"),
    data: z.object({
      object: paymentIntentSchema,
    }),
  });

// Invoice Paid event
export const stripeInvoicePaidEventSchema = stripeBaseEventSchema.extend({
  type: z.literal("invoice.payment_succeeded"),
  data: z.object({
    object: z.object({
      id: z.string(),
      object: z.literal("invoice"),
      amount_paid: z.number(),
      customer: z.string(),
      subscription: z.string().nullable(),
    }),
  }),
});

// Subscription Created event
export const stripeSubscriptionCreatedEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("customer.subscription.created"),
    data: z.object({
      object: z.object({
        id: z.string(),
        object: z.literal("subscription"),
        customer: z.string(),
        status: z.string(),
        billing_cycle_anchor: z.number(),
        start_date: z.number(),
      }),
    }),
  });

// Checkout Session schema (session.id is the cs_... stored in Payment.paymentIntent)
export const stripeCheckoutSessionObjectSchema = z
  .object({
    id: z.string(), // cs_... ID — matches Payment.paymentIntent
    object: z.literal("checkout.session").optional(),
    payment_intent: z.string().nullable().optional(), // pi_... ID — the underlying PaymentIntent
    payment_status: z.string().optional(), // "paid", "unpaid", "no_payment_required"
    status: z.string().optional(), // "complete", "expired", "open"
    metadata: metadataSchema.optional(),
    amount_total: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
  })
  .passthrough();

export const stripeCheckoutSessionCompletedObjectSchema =
  stripeCheckoutSessionObjectSchema.extend({
    payment_status: z.string(),
  });

export const stripePaymentIntentObjectSchema = paymentIntentSchema.passthrough();

// FIX CF-3: Checkout Session Completed event
// This is the correct event for Stripe Checkout Sessions.
// The session.id (cs_...) is what we store in Payment.paymentIntent.
export const stripeCheckoutSessionCompletedEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("checkout.session.completed"),
    data: z.object({
      object: stripeCheckoutSessionCompletedObjectSchema,
    }),
  });

// Checkout Session Expired event (session timed out without payment)
export const stripeCheckoutSessionExpiredEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("checkout.session.expired"),
    data: z.object({
      object: stripeCheckoutSessionObjectSchema,
    }),
  });

export const stripeRefundEntrySchema = z
  .object({
    id: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.string().nullable().optional(),
    charge: z
      .union([z.string(), z.object({ id: z.string() }).passthrough()])
      .nullable()
      .optional(),
  })
  .passthrough();

export const stripeChargeRefundedObjectSchema = z
  .object({
    id: z.string(),
    payment_intent: z.string().nullable().optional(),
    refunds: z
      .object({
        data: z.array(stripeRefundEntrySchema).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const stripeChargeRefundedEventSchema = stripeBaseEventSchema.extend({
  type: z.literal("charge.refunded"),
  data: z.object({
    object: stripeChargeRefundedObjectSchema,
  }),
});

export const stripeDisputeCreatedObjectSchema = z
  .object({
    id: z.string(),
    charge: z.string(),
    amount: z.number(),
    currency: z.string(),
    reason: z.string(),
    status: z.string(),
    evidence_details: z
      .object({
        due_by: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    is_charge_refundable: z.boolean().optional(),
  })
  .passthrough();

export const stripeDisputeCreatedEventSchema = stripeBaseEventSchema.extend({
  type: z.literal("charge.dispute.created"),
  data: z.object({
    object: stripeDisputeCreatedObjectSchema,
  }),
});

export const stripeDisputeUpdatedObjectSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    evidence: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const stripeDisputeUpdatedEventSchema = stripeBaseEventSchema.extend({
  type: z.enum(["charge.dispute.updated", "charge.dispute.closed"]),
  data: z.object({
    object: stripeDisputeUpdatedObjectSchema,
  }),
});

export const stripePayoutObjectSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    failure_code: z.string().nullable().optional(),
    failure_message: z.string().nullable().optional(),
  })
  .passthrough();

export const stripePayoutEventSchema = stripeBaseEventSchema.extend({
  type: z.enum([
    "payout.created",
    "payout.paid",
    "payout.failed",
    "payout.canceled",
  ]),
  data: z.object({
    object: stripePayoutObjectSchema,
  }),
});

export const stripeAccountObjectSchema = z
  .object({
    id: z.string(),
    charges_enabled: z.boolean().optional(),
    payouts_enabled: z.boolean().optional(),
    details_submitted: z.boolean().optional(),
  })
  .passthrough();

export const stripeAccountUpdatedEventSchema = stripeBaseEventSchema.extend({
  type: z.literal("account.updated"),
  data: z.object({
    object: stripeAccountObjectSchema,
  }),
});

export const stripeTransferObjectSchema = z
  .object({
    id: z.string(),
    amount: z.number().optional(),
    destination: z.string().nullable().optional(),
    reversed: z.boolean().optional(),
  })
  .passthrough();

export const stripeTransferEventSchema = stripeBaseEventSchema.extend({
  type: z.enum(["transfer.created", "transfer.reversed"]),
  data: z.object({
    object: stripeTransferObjectSchema,
  }),
});

