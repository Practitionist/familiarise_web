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

/** Payer instrument fields; a malformed one reads as absent and never fails the event. */
const payerInstrumentShape = {
  vpa: z.string().nullable().optional().catch(undefined),
  contact: z.string().nullable().optional().catch(undefined),
  upi: z
    .object({ vpa: z.string().nullable().optional() })
    .passthrough()
    .nullable()
    .optional()
    .catch(undefined),
};

export const razorpayPaymentEntitySchema = z
  .object({
    id: z.string(),
    amount: z.number().int().positive(),
    currency: z.string(),
    status: z.string(),
    order_id: z.string().nullable().optional(),
    notes: razorpayNotesSchema,
    method: z.string().optional().catch(undefined),
    error_description: z.string().nullable().optional(),
    /** Gateway fee in paise, GST included; set once captured. */
    fee: z.number().int().nonnegative().nullable().optional(),
    /** GST on the fee, in paise. */
    tax: z.number().int().nonnegative().nullable().optional(),
    ...payerInstrumentShape,
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

const numericScoreSchema = z
  .union([z.number(), z.string()])
  .transform((v) => (v === "" ? null : Number(v)))
  .pipe(z.number().finite().nullable())
  .nullish()
  .transform((v) => v ?? undefined);

const validationBankAccountSchema = z
  .object({
    bank_routing_code: z.string().nullable().optional(),
    ifsc: z.string().nullable().optional(),
    account_number: z.string().nullable().optional(),
    bank_name: z.string().nullable().optional(),
    account_type: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const validationResultsSchema = z
  .object({
    account_status: z
      .enum(["active", "inactive", "invalid", ""])
      .nullable()
      .optional(),
    registered_name: z.string().nullable().optional(),
    name_match_score: numericScoreSchema,
    bank_account: validationBankAccountSchema,
  })
  .passthrough()
  .nullish()
  .transform((v) => v ?? undefined);

export const razorpayPayoutStatusDetailsSchema = z
  .object({
    description: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

export const razorpayPayoutErrorSchema = z
  .object({
    code: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

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
    results: validationResultsSchema,
    validation_results: validationResultsSchema,
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
    /** Paise Razorpay pulled from the balance; 0 until the dispute is lost. */
    amount_deducted: z.number().nullable().optional(),
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
      entity: z
        .object({
          id: z.string(),
          amount: z.number().int().optional(),
          notes: razorpayNotesSchema,
          method: z.string().optional().catch(undefined),
          fee: z.number().int().nonnegative().nullable().optional(),
          tax: z.number().int().nonnegative().nullable().optional(),
          ...payerInstrumentShape,
        })
        .passthrough(),
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

/** The event type a signed delivery is stored under when its body names no event. */
export const UNREADABLE_RAZORPAY_EVENT = "unreadable";

const ingressEntitySchema = z.object({
  entity: z.object({ id: z.string().min(1) }).passthrough(),
});

/**
 * All the inbox needs from a signed delivery before it is stored: the event
 * name and, per payload member, the entity id that keys dedupe. Nothing here
 * validates a shape a handler depends on.
 */
export function readRazorpayIngress(raw: unknown): {
  eventType: string;
  accountId: string | undefined;
  /** What the inbox row stores: the payload member, or the whole body when it names no event. */
  stored: unknown;
  entityId: (member: string) => string | undefined;
} {
  const envelope = z
    .object({
      event: z.string().min(1),
      account_id: z.string().optional().catch(undefined),
      payload: z.unknown(),
    })
    .safeParse(raw);
  if (!envelope.success) {
    return {
      eventType: UNREADABLE_RAZORPAY_EVENT,
      accountId: undefined,
      stored: raw,
      entityId: () => undefined,
    };
  }
  const members = z
    .record(z.string(), z.unknown())
    .catch({})
    .parse(envelope.data.payload);
  return {
    eventType: envelope.data.event,
    accountId: envelope.data.account_id,
    stored: envelope.data.payload ?? {},
    entityId: (member) => {
      const entity = ingressEntitySchema.safeParse(members[member]);
      return entity.success ? entity.data.entity.id : undefined;
    },
  };
}

// Loose envelope for entity extraction; enums and flags stay strings here and each handler parses its own entity.
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
                speed_requested: z.string().nullable().optional(),
                speed_processed: z.string().nullable().optional(),
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
                deduct_at_onset: z.unknown().optional(),
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
                status_details: razorpayPayoutStatusDetailsSchema,
                error: razorpayPayoutErrorSchema,
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
          .optional()
          .catch(undefined),
        settlement: z
          .object({
            entity: z
              .object({
                id: z.string().optional(),
                amount: z.number().optional(),
                status: z.string().optional(),
                fees: z.number().optional(),
                tax: z.number().optional(),
                utr: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
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

/** The pre-written Payment id an approval order's notes carry, so a capture can find a row whose order was never recorded. */
export const orderNotesPaymentIdSchema = z.object({
  familiarisePaymentId: z.string().min(1).max(64).optional(),
});
