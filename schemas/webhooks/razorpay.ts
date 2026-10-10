import { z } from "zod";

export const razorpayNotesSchema = z
  .unknown()
  .transform((val): Record<string, string> => {
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      return {};
    }
    const normalized: Record<string, string> = {};
    for (const [key, raw] of Object.entries(val)) {
      if (
        typeof raw === "string" ||
        typeof raw === "number" ||
        typeof raw === "boolean"
      ) {
        normalized[key] = String(raw);
      } else if (raw === null || raw === undefined) {
        normalized[key] = "";
      }
    }
    return normalized;
  });

export const razorpayPaymentEntitySchema = z
  .object({
    id: z.string(),
    amount: z.number().int().positive(),
    currency: z.string(),
    status: z.string(),
    order_id: z.string().nullable().optional(),
    notes: razorpayNotesSchema,
    error_description: z.string().nullable().optional(),
  })
  .passthrough();

export type RazorpayPaymentEntity = z.infer<typeof razorpayPaymentEntitySchema>;

export const razorpayOrderEntitySchema = z
  .object({
    id: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
    notes: razorpayNotesSchema,
  })
  .passthrough();

export type RazorpayOrderEntity = z.infer<typeof razorpayOrderEntitySchema>;

/**
 * A `payments.fetch` answer: capture state, amount, and normalized notes map.
 */
export const razorpayFetchedPaymentSchema = z
  .object({
    order_id: z.string(),
    status: z.string(),
    amount: z.number().int().positive(),
    currency: z.string(),
    notes: razorpayNotesSchema,
  })
  .passthrough();

const pennyDropResultsSchema = z
  .object({
    account_status: z.enum(["active", "invalid"]).nullable().optional(),
    registered_name: z.string().nullable().optional(),
    name_match_score: z.number().nullable().optional(),
  })
  .passthrough()
  .nullish()
  .transform((v) => v ?? undefined);

const reversePennyDropResultsSchema = z
  .object({
    account_status: z
      .enum(["active", "inactive", "invalid"])
      .nullable()
      .optional(),
    registered_name: z.string().nullable().optional(),
    name_match_score: z.number().nullable().optional(),
    bank_account: z
      .object({
        bank_routing_code: z.string().nullable().optional(),
        account_number: z.string().nullable().optional(),
        bank_name: z.string().nullable().optional(),
        account_type: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .nullish()
  .transform((v) => v ?? undefined);

export const fundAccountValidationEntitySchema = z
  .object({
    id: z.string(),
    reference_id: z.string().nullable().optional(),
    fund_account: z
      .object({
        id: z.string(),
        account_type: z.string().optional(),
        vpa: z
          .object({
            address: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullish()
      .transform((v) => v ?? undefined),
    status: z.string().optional(),
    results: pennyDropResultsSchema,
    validation_results: reversePennyDropResultsSchema,
    status_details: z
      .object({
        description: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        reason: z.string().nullable().optional(),
      })
      .passthrough()
      .nullish()
      .transform((v) => v ?? undefined),
    notes: razorpayNotesSchema,
  })
  .passthrough();

export type RazorpayFundAccountValidationEntity = z.infer<
  typeof fundAccountValidationEntitySchema
>;

export const disputeUpdateEntitySchema = z
  .object({
    id: z.string(),
    status: z.string(),
    respond_by: z.number().nullable().optional(),
    phase: z.string().nullable().optional(),
    amount: z.number().optional(),
    reason_code: z.string().nullable().optional(),
    reason_description: z.string().nullable().optional(),
  })
  .passthrough();

export type RazorpayDisputeUpdateEntity = z.infer<
  typeof disputeUpdateEntitySchema
>;

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
  payment: z
    .object({
      entity: z.object({ id: z.string(), amount: z.number().int().optional() }),
    })
    .optional()
    .catch(undefined),
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

// Loose envelope schema for idempotency key derivation and entity extraction.
export const razorpayWebhookEnvelopeSchema = z
  .object({
    event: z.string(),
    account_id: z.string().optional(),
    payload: z
      .object({
        payment: z
          .object({
            entity: z
              .object({
                id: z.string().optional(),
                order_id: z.string().nullable().optional(),
                notes: razorpayNotesSchema,
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        order: z
          .object({
            entity: z
              .object({
                id: z.string().optional(),
                notes: razorpayNotesSchema,
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        refund: z
          .object({
            entity: z
              .object({
                id: z.string().optional(),
                payment_id: z.string().optional(),
                amount: z.number().optional(),
                currency: z.string().optional(),
                status: z.string().optional(),
                notes: razorpayNotesSchema,
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        dispute: z
          .object({
            entity: z
              .object({
                id: z.string().optional(),
                payment_id: z.string().optional(),
                amount: z.number().optional(),
                currency: z.string().optional(),
                reason_code: z.string().nullable().optional(),
                reason_description: z.string().nullable().optional(),
                status: z.string().optional(),
                respond_by: z.number().nullable().optional(),
                deduct_at_onset: z.boolean().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        payout: z
          .object({
            entity: z
              .object({
                id: z.string().optional(),
                status: z.string().optional(),
                failure_reason: z.string().nullable().optional(),
                utr: z.string().nullable().optional(),
                reference_id: z.string().nullable().optional(),
                status_details: z
                  .object({
                    description: z.string().nullable().optional(),
                    source: z.string().nullable().optional(),
                    reason: z.string().nullable().optional(),
                  })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        "fund_account.validation": z
          .object({
            entity: fundAccountValidationEntitySchema.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RazorpayWebhookEnvelope = z.infer<
  typeof razorpayWebhookEnvelopeSchema
>;
