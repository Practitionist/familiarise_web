/**
 * The back-office money lists' response bodies as Zod schemas, shared by the
 * routes that build them and the screens that parse them. Client-safe: no Prisma.
 */

import {
  AppointmentsType,
  DisputeStatus,
  PaymentGateway,
  PaymentStatus,
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

const pageMeta = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
};

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
