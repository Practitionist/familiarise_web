/**
 * The back-office money lists' response bodies as Zod schemas, shared by the
 * routes that build them and the screens that parse them. Client-safe: no Prisma.
 */

import {
  AppointmentsType,
  DisputeStatus,
  EarningStatus,
  OpsActionProposalStatus,
  PaymentGateway,
  PaymentStatus,
  PayoutMethod,
  PayoutStatus,
  RefundStatus,
} from "@prisma/client";
import { z } from "zod";

/** A person as a money row names them; email is null where the viewer may not see it. */
export const personRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});
export type PersonRef = z.infer<typeof personRefSchema>;

/** A booking as a money row names it (`bookingRefOf`). */
export const bookingRefSchema = z.object({
  id: z.string(),
  type: z.nativeEnum(AppointmentsType),
  title: z.string(),
});

/** What a console target names: the person and the booking behind its id. */
export const targetRefSchema = z.object({
  person: personRefSchema.nullable(),
  booking: bookingRefSchema.nullable(),
});
export type TargetRef = z.infer<typeof targetRefSchema>;

const pageMeta = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
};

const offsetPagination = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const paymentListItemSchema = z.object({
  id: z.string(),
  /** Paise. */
  amount: z.number(),
  currency: z.string(),
  paymentIntent: z.string(),
  paymentGateway: z.nativeEnum(PaymentGateway),
  paymentStatus: z.nativeEnum(PaymentStatus),
  isMockPayment: z.boolean(),
  createdAt: z.string(),
  buyer: personRefSchema.nullable(),
  booking: bookingRefSchema.nullable(),
  consumerInvoice: z
    .object({ id: z.string(), invoiceNumber: z.string(), issuedAt: z.string() })
    .nullable(),
});
export type PaymentListItem = z.infer<typeof paymentListItemSchema>;

export const paymentListPageSchema = z.object({
  payments: z.array(paymentListItemSchema),
  ...pageMeta,
});

/** The payment a refund or dispute row came from, with who paid and for what. */
const moneyRowPaymentSchema = z
  .object({
    id: z.string(),
    paymentIntent: z.string(),
    buyer: personRefSchema.nullable(),
    booking: bookingRefSchema.nullable(),
  })
  .nullable();

export const refundListItemSchema = z.object({
  id: z.string(),
  refundId: z.string(),
  /** Paise. */
  amountPaise: z.number(),
  currency: z.string(),
  status: z.nativeEnum(RefundStatus),
  reason: z.string().nullable(),
  paymentGateway: z.nativeEnum(PaymentGateway),
  createdAt: z.string(),
  payment: moneyRowPaymentSchema,
});
export type RefundListItem = z.infer<typeof refundListItemSchema>;

export const refundListPageSchema = z.object({
  refunds: z.array(refundListItemSchema),
  ...pageMeta,
  stats: z.object({
    pendingCount: z.number().int().nonnegative(),
    succeededCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  }),
});

export const disputeListItemSchema = z.object({
  id: z.string(),
  disputeId: z.string(),
  /** Paise. */
  amountPaise: z.number(),
  currency: z.string(),
  status: z.nativeEnum(DisputeStatus),
  reason: z.string().nullable(),
  paymentGateway: z.nativeEnum(PaymentGateway),
  dueBy: z.string().nullable(),
  createdAt: z.string(),
  payment: moneyRowPaymentSchema,
});
export type DisputeListItem = z.infer<typeof disputeListItemSchema>;

export const disputeListPageSchema = z.object({
  disputes: z.array(disputeListItemSchema),
  ...pageMeta,
  urgentDisputes: z.number().int().nonnegative(),
  stats: z.object({
    underReviewCount: z.number().int().nonnegative(),
    wonCount: z.number().int().nonnegative(),
  }),
});

/** One expert payout as `getOperatorPayouts` returns it. */
export const payoutListItemSchema = z.object({
  id: z.string(),
  consultantProfileId: z.string(),
  consultantUserId: z.string(),
  consultantName: z.string(),
  consultantEmail: z.string().nullable(),
  /** Paise. */
  amount: z.number(),
  currency: z.string(),
  status: z.nativeEnum(PayoutStatus),
  method: z.nativeEnum(PayoutMethod),
  provider: z.nativeEnum(PaymentGateway),
  kind: z.string().nullable(),
  earningsCount: z.number().int().nonnegative(),
  approvedAt: z.string().nullable(),
  processedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  /** The MSME statutory pay-by date; null for a vendor that is not MSME. */
  mustPayByDate: z.string().nullable(),
});
export type PayoutListItem = z.infer<typeof payoutListItemSchema>;

export const payoutListPageSchema = z.object({
  payouts: z.array(payoutListItemSchema),
  pagination: offsetPagination,
});

/** One organisation payout, with who created, org-approved and co-approved it. */
export const orgPayoutListItemSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organization: z.object({ name: z.string(), slug: z.string() }),
  /** Paise. */
  amountPaise: z.number(),
  currency: z.string(),
  status: z.nativeEnum(PayoutStatus),
  createdAt: z.string(),
  platformApprovalRequiredAt: z.string().nullable(),
  platformHeldAt: z.string().nullable(),
  createdByUser: personRefSchema.nullable(),
  orgApprovedByUser: personRefSchema.nullable(),
  approvedByUser: personRefSchema.nullable(),
});
export type OrgPayoutListItem = z.infer<typeof orgPayoutListItemSchema>;

export const orgPayoutListPageSchema = z.object({
  payouts: z.array(orgPayoutListItemSchema),
  pagination: offsetPagination,
});

/** The expert an Earnings link opens on (`?consultantProfileId=`); anything else is no filter. */
export const earningsExpertParam = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional()
  .catch(undefined);

/** One expert earning, with the payment it came from and who paid for what. */
export const earningListItemSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  consultantProfileId: z.string(),
  /** Paise. */
  consultantSharePaise: z.number(),
  status: z.nativeEnum(EarningStatus),
  holdUntil: z.string().nullable(),
  consultantProfile: z.object({
    userId: z.string(),
    user: z.object({
      name: z.string().nullable(),
      email: z.string().nullable(),
    }),
  }),
  payment: z
    .object({
      id: z.string(),
      buyer: personRefSchema.nullable(),
      booking: bookingRefSchema.nullable(),
    })
    .nullable(),
});
export type EarningListItem = z.infer<typeof earningListItemSchema>;

export const earningListPageSchema = z.object({
  earnings: z.array(earningListItemSchema),
  pagination: offsetPagination,
});

const namedUserSchema = z.object({ id: z.string(), name: z.string() });

/** One second-approval proposal, with what its target names. */
export const proposalListItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  surface: z.string(),
  targetKind: z.string(),
  targetId: z.string(),
  target: targetRefSchema.nullable(),
  /** Paise; null for an action without a bounded amount. */
  amountPaise: z.number().nullable(),
  reason: z.string(),
  status: z.nativeEnum(OpsActionProposalStatus),
  proposedBy: namedUserSchema.nullable(),
  decidedBy: namedUserSchema.nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type ProposalListItem = z.infer<typeof proposalListItemSchema>;

export const proposalPageSchema = z.object({
  proposals: z.array(proposalListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type ProposalPage = z.infer<typeof proposalPageSchema>;

/** Parses a list body, so a malformed 200 takes the screen's error path. */
export async function readListBody<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  failure: string,
): Promise<z.infer<S>> {
  if (!res.ok) throw new Error(failure);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error(failure);
  return parsed.data;
}
