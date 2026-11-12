/**
 * The capture plumbing the standalone sale rails (replays, digital products)
 * share: the order-note tax split, the CARD leg, and staging a capture that
 * fulfils nothing under the auto-refund marker, refunded after commit and
 * re-driven by retry-auto-refunds.
 */
import { z } from "zod";
import type { PaymentStatus, Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "@/lib/prisma";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { postUnappliedReceipt } from "@/lib/payments/ledger/unapplied-receipts";
import {
  AUTO_REFUND_PENDING_PREFIX,
  AUTO_REFUND_STUCK_PREFIX,
  AUTO_REFUNDED_PREFIX,
  settledAutoRefundDescription,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { reportSentryError } from "@/lib/observability/report";

export const paiseNote = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

/** The GST regime the order was priced under; orders minted before the note carry none. */
export const gstRegimeNote = z.enum(["REGISTERED", "UNREGISTERED"]);

const chargeSplitSchema = z.object({
  originalAmountPaise: paiseNote,
  taxAmountPaise: paiseNote,
  buyerCountry: z.string().length(2),
  gstRegime: gstRegimeNote.optional(),
});

export interface StandaloneCharge {
  originalAmount: number;
  taxAmount: number;
  buyerCountry: string | null;
  gstRegime: z.infer<typeof gstRegimeNote> | null;
}

/**
 * The tax split the mint stamped on the order notes. An order without a valid
 * split settles untaxed, as charged, and alerts.
 */
export function resolveStandaloneCharge(
  rail: string,
  orderId: string,
  chargedPaise: number,
  notes: Record<string, string> | undefined,
): StandaloneCharge {
  const parsed = chargeSplitSchema.safeParse(notes ?? {});
  if (
    parsed.success &&
    parsed.data.originalAmountPaise + parsed.data.taxAmountPaise ===
      chargedPaise
  ) {
    return {
      originalAmount: parsed.data.originalAmountPaise,
      taxAmount: parsed.data.taxAmountPaise,
      buyerCountry: parsed.data.buyerCountry.toUpperCase(),
      gstRegime: parsed.data.gstRegime ?? null,
    };
  }
  Sentry.captureMessage(
    `[${rail}] order notes missing or invalid tax split: ${orderId}`,
    { level: "error", tags: { subsystem: "payments" } },
  );
  return {
    originalAmount: chargedPaise,
    taxAmount: 0,
    buyerCountry: null,
    gstRegime: null,
  };
}

const razorpayMethodSchema = z.string().regex(/^[a-z_]{1,32}$/);

/**
 * Payment.paymentMethod for a gateway capture, from Razorpay's `method`.
 * "WALLET" means the organisation wallet, so a prepaid wallet is GATEWAY_WALLET.
 */
export function gatewayPaymentMethod(method: string | undefined): string {
  const parsed = razorpayMethodSchema.safeParse(method);
  if (!parsed.success) return "CARD";
  return parsed.data === "wallet"
    ? "GATEWAY_WALLET"
    : parsed.data.toUpperCase();
}

export const AUTO_REFUND_MARKERS = [
  AUTO_REFUND_PENDING_PREFIX,
  AUTO_REFUNDED_PREFIX,
  AUTO_REFUND_STUCK_PREFIX,
];

export type CaptureOutcome =
  | { kind: "settled"; paymentId: string }
  | { kind: "refund"; paymentId: string; reason: string; marker: string };

/** The order's Payment moved between the capture's read and its write. */
export class OrderPaymentMovedError extends Error {
  constructor(readonly paymentId: string) {
    super(`order payment ${paymentId} changed status during its capture`);
    this.name = "OrderPaymentMovedError";
  }
}

/**
 * Settles an order's pre-mint Payment by CAS on the status the capture read.
 * A lost race throws, so the whole capture rolls back and the webhook's
 * redelivery settles it from fresh state; nothing is written half-way.
 */
export async function settleOrderPayment(
  tx: Tx,
  orderPayment: { id: string; paymentStatus: PaymentStatus },
  data: Omit<Prisma.PaymentUncheckedUpdateManyInput, "paymentStatus">,
) {
  const { count } = await tx.payment.updateMany({
    where: { id: orderPayment.id, paymentStatus: orderPayment.paymentStatus },
    data: { ...data, paymentStatus: "SUCCEEDED" },
  });
  if (count === 0) throw new OrderPaymentMovedError(orderPayment.id);
  return tx.payment.findUniqueOrThrow({ where: { id: orderPayment.id } });
}

/** The leg trigger rejects a positive Payment without legs at commit. */
export function cardLeg(amountPaise: number, paymentIntent: string) {
  return {
    create: { source: "CARD" as const, amountPaise, sourceRef: paymentIntent },
  };
}

export interface StageRefundInput {
  paymentIntent: string;
  buyerId: string;
  chargedPaise: number;
  charge: StandaloneCharge;
  organizationId: string | null;
  gatewayPaymentId: string | undefined;
  /** Razorpay's `method` for the capture; absent reads as a card. */
  method?: string;
  reason: string;
}

/**
 * A row already staged for the intent is re-driven only while its marker is
 * still pending; a PENDING order row is claimed into the marker.
 */
async function stageExistingCaptureRefund(
  tx: Tx,
  existing: {
    id: string;
    description: string | null;
    amount: number;
    paymentStatus: string;
    gatewayPaymentId: string | null;
  },
  input: StageRefundInput,
  marker: string,
  notGranted: string,
): Promise<CaptureOutcome | null> {
  if (
    existing.gatewayPaymentId &&
    input.gatewayPaymentId &&
    existing.gatewayPaymentId !== input.gatewayPaymentId &&
    input.paymentIntent !== input.gatewayPaymentId
  ) {
    return stageCaptureRefund(
      tx,
      { ...input, paymentIntent: input.gatewayPaymentId },
      notGranted,
    );
  }
  if (!existing.description?.startsWith(AUTO_REFUND_PENDING_PREFIX)) {
    if (existing.paymentStatus !== "PENDING") {
      return null;
    }
    const claimed = await tx.payment.updateMany({
      where: { id: existing.id, paymentStatus: "PENDING" },
      data: {
        amount: input.chargedPaise,
        originalAmount: input.charge.originalAmount,
        taxAmount: input.charge.taxAmount,
        paymentStatus: "SUCCEEDED",
        paymentMethod: gatewayPaymentMethod(input.method),
        gatewayPaymentId: input.gatewayPaymentId,
        capturedAt: new Date(),
        description: marker,
      },
    });
    if (claimed.count === 0) return null;
    // The CARD leg must equal the amount for payment_legs_sum_to_amount at COMMIT.
    const updatedLegs = await tx.paymentLeg.updateMany({
      where: { paymentId: existing.id, source: "CARD" },
      data: { amountPaise: input.chargedPaise },
    });
    if (updatedLegs.count === 0) {
      await tx.paymentLeg.create({
        data: {
          paymentId: existing.id,
          source: "CARD",
          amountPaise: input.chargedPaise,
          sourceRef: input.paymentIntent,
        },
      });
    }
    await postUnappliedReceipt(tx, {
      paymentId: existing.id,
      capturedPaise: input.chargedPaise,
    });
    return {
      kind: "refund",
      paymentId: existing.id,
      reason: input.reason,
      marker,
    };
  }
  await postUnappliedReceipt(tx, {
    paymentId: existing.id,
    capturedPaise: existing.amount,
  });
  return {
    kind: "refund",
    paymentId: existing.id,
    reason: input.reason,
    marker: existing.description,
  };
}

/** Record a capture that fulfils nothing as a SUCCEEDED Payment carrying the auto-refund marker. */
export async function stageCaptureRefund(
  tx: Tx,
  input: StageRefundInput,
  /** Appended to the marker, e.g. "Replay NOT granted." */
  notGranted: string,
): Promise<CaptureOutcome | null> {
  const marker = `${AUTO_REFUND_PENDING_PREFIX} ${input.reason}. ${notGranted}`;
  const existing = await tx.payment.findUnique({
    where: { paymentIntent: input.paymentIntent },
    select: {
      id: true,
      description: true,
      amount: true,
      paymentStatus: true,
      gatewayPaymentId: true,
    },
  });
  if (existing) {
    return stageExistingCaptureRefund(tx, existing, input, marker, notGranted);
  }
  const created = await tx.payment.create({
    data: {
      userId: input.buyerId,
      appointmentId: null,
      amount: input.chargedPaise,
      originalAmount: input.charge.originalAmount,
      taxAmount: input.charge.taxAmount,
      gstRegime: input.charge.gstRegime,
      currency: "INR",
      paymentMethod: gatewayPaymentMethod(input.method),
      paymentIntent: input.paymentIntent,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      capturedAt: new Date(),
      description: marker,
      organizationId: input.organizationId,
      legs: cardLeg(input.chargedPaise, input.paymentIntent),
      ...(input.gatewayPaymentId
        ? { gatewayPaymentId: input.gatewayPaymentId }
        : {}),
    },
    select: { id: true },
  });
  await postUnappliedReceipt(tx, {
    paymentId: created.id,
    capturedPaise: input.chargedPaise,
  });
  return {
    kind: "refund",
    paymentId: created.id,
    reason: input.reason,
    marker,
  };
}

/**
 * Refund a staged capture after commit and settle its marker. A failure keeps
 * the marker pending, so retry-auto-refunds re-drives it.
 */
export async function refundStagedCapture(
  outcome: Extract<CaptureOutcome, { kind: "refund" }>,
  context: { orderId: string; dedupePrefix: string },
): Promise<void> {
  try {
    const refundOutcome = await refundBookingPayment({
      paymentId: outcome.paymentId,
      reason: outcome.reason,
      initiatedByUserId: null,
      dedupeKey: `${context.dedupePrefix}:${outcome.paymentId}`,
    });
    if (refundOutcome?.status !== "PENDING") {
      await prisma.payment.updateMany({
        where: { id: outcome.paymentId, description: outcome.marker },
        data: { description: settledAutoRefundDescription(outcome.marker) },
      });
    }
  } catch (refundError) {
    reportSentryError(refundError, {
      subsystem: "payments",
      extra: { orderId: context.orderId, paymentId: outcome.paymentId },
    });
  }
}
