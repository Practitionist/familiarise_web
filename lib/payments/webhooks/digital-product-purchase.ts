/**
 * Digital product sale settlement.
 *
 * A capture settles its DigitalProductPurchase (PENDING, or FAILED on a late
 * retry of the same order) to SUCCEEDED with the Payment, CARD leg, earnings,
 * BOOKING journal and staged receipt email in one transaction, under the product
 * row lock. A capture that cannot fulfil a purchase is staged under the
 * auto-refund marker and refunded after commit.
 */
import { z } from "zod";
import type {
  DigitalProductPurchaseStatus,
  DigitalProductStatus,
  OrgPlanVisibility,
  Prisma,
} from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "@/lib/prisma";
import {
  createEarningsFromPayment,
  type CreateEarningsParams,
} from "@/lib/payments/payouts/earnings-service";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  flushDigitalProductReceipt,
  prepareDigitalProductReceipt,
  stageDigitalProductReceipt,
  type DigitalProductReceipt,
} from "@/lib/digital-products/purchase-email";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import { lockDeliverableDigitalProduct } from "@/lib/digital-products/product-lock";
import { DIGITAL_PRODUCT_SALE_PREFIX } from "@/lib/payments/webhooks/auto-refund-marker";
import {
  AUTO_REFUND_MARKERS,
  cardLeg,
  gatewayPaymentMethod,
  gstRegimeNote,
  paiseNote,
  refundStagedCapture,
  resolveStandaloneCharge,
  settleOrderPayment,
  stageCaptureRefund,
  type CaptureOutcome,
  type StageRefundInput,
  type StandaloneCharge,
} from "@/lib/payments/webhooks/standalone-sale-capture";

const RAIL = "digital-product-purchase";
const NOT_GRANTED = "Digital product NOT granted.";

/** The notes a digital product order is minted with; the capture reads them back. */
export const digitalProductChargeNotesSchema = z.object({
  type: z.literal("digital_product_purchase"),
  productId: z.string().min(1),
  userId: z.string().min(1),
  originalAmountPaise: paiseNote,
  taxAmountPaise: paiseNote,
  buyerCountry: z.string().length(2),
  gstRegime: gstRegimeNote,
});
const buyerNoteSchema = digitalProductChargeNotesSchema.pick({ userId: true });

const PURCHASE_SELECT = {
  id: true,
  productId: true,
  buyerId: true,
  amountPaise: true,
  status: true,
  gatewayPaymentId: true,
  product: {
    select: {
      id: true,
      consultantProfileId: true,
      organizationId: true,
      visibility: true,
      status: true,
      takenDownAt: true,
    },
  },
} as const satisfies Prisma.DigitalProductPurchaseSelect;

interface SettlingPurchase {
  id: string;
  productId: string;
  buyerId: string;
  amountPaise: number;
  status: DigitalProductPurchaseStatus;
  gatewayPaymentId: string | null;
  product: {
    id: string;
    consultantProfileId: string;
    organizationId: string | null;
    visibility: OrgPlanVisibility;
    status: DigitalProductStatus;
    takenDownAt: Date | null;
  };
}

function stageRefund(tx: Tx, input: StageRefundInput) {
  return stageCaptureRefund(tx, input, NOT_GRANTED);
}

/** Refund a capture whose purchase row is gone to the buyer the order notes name. */
async function refundOrphanCapture(
  tx: Tx,
  input: {
    orderId: string;
    gatewayPaymentId: string | undefined;
    notes: Record<string, string> | undefined;
    capturedPaise: number | undefined;
    method: string | undefined;
  },
): Promise<CaptureOutcome | null> {
  const { orderId, capturedPaise } = input;
  const buyer = buyerNoteSchema.safeParse(input.notes ?? {});
  if (
    !buyer.success ||
    capturedPaise === undefined ||
    !Number.isSafeInteger(capturedPaise) ||
    capturedPaise <= 0
  ) {
    return null;
  }
  const buyerRow = await tx.user.findUnique({
    where: { id: buyer.data.userId },
    select: { id: true },
  });
  if (!buyerRow) return null;
  return stageRefund(tx, {
    paymentIntent: orderId,
    buyerId: buyerRow.id,
    chargedPaise: capturedPaise,
    charge: resolveStandaloneCharge(RAIL, orderId, capturedPaise, input.notes),
    organizationId: null,
    gatewayPaymentId: input.gatewayPaymentId,
    method: input.method,
    reason: `capture on digital product order ${orderId}; its purchase no longer exists`,
  });
}

/** A capture on a settled order is a second payment unless it is the settling one redelivered. */
async function isDuplicateCapture(
  tx: Tx,
  input: {
    purchaseId: string;
    settledBy: string | null;
    orderId: string;
    gatewayPaymentId: string;
  },
): Promise<boolean> {
  const { purchaseId, orderId, gatewayPaymentId } = input;
  let settledBy = input.settledBy;
  if (!settledBy) {
    const stamped = await tx.digitalProductPurchase.updateMany({
      where: { id: purchaseId, gatewayPaymentId: null },
      data: { gatewayPaymentId },
    });
    if (stamped.count === 1) {
      await tx.payment.updateMany({
        where: { paymentIntent: orderId, gatewayPaymentId: null },
        data: { gatewayPaymentId },
      });
      return false;
    }
    const current = await tx.digitalProductPurchase.findUnique({
      where: { id: purchaseId },
      select: { gatewayPaymentId: true },
    });
    settledBy = current?.gatewayPaymentId ?? null;
  }
  return settledBy !== gatewayPaymentId;
}

/** Why a capture on an unsettled order must be refunded instead of granted, or null. */
function rejectionFor(input: {
  purchase: SettlingPurchase;
  orderPayment: { description: string | null } | null;
  orderId: string;
  gatewayPaymentId?: string;
}): { paymentIntent: string; reason: string } | null {
  const { purchase, orderId } = input;
  if (
    AUTO_REFUND_MARKERS.some((prefix) =>
      input.orderPayment?.description?.startsWith(prefix),
    )
  ) {
    return {
      paymentIntent: input.gatewayPaymentId ?? orderId,
      reason: `late capture on digital product order ${orderId}`,
    };
  }
  if (purchase.product.takenDownAt) {
    return {
      paymentIntent: orderId,
      reason: `capture on digital product order ${orderId}; the product was taken down`,
    };
  }
  if (purchase.status === "FAILED" && purchase.product.status !== "PUBLISHED") {
    return {
      paymentIntent: orderId,
      reason: `late capture on digital product order ${orderId}; the product is no longer for sale`,
    };
  }
  return null;
}

/** Settle a claimed purchase: its Payment, CARD leg, purchase link and earnings. */
async function settleProductSale(
  tx: Tx,
  input: {
    purchase: SettlingPurchase;
    orderPayment: Omit<CreateEarningsParams["payment"], "appointment"> | null;
    orderId: string;
    gatewayPaymentId: string | undefined;
    method: string | undefined;
    chargedPaise: number;
    charge: StandaloneCharge;
  },
): Promise<CaptureOutcome> {
  const { purchase, orderPayment, orderId, gatewayPaymentId, chargedPaise } =
    input;
  const paymentMethod = gatewayPaymentMethod(input.method);
  const { charge } = input;
  const product = purchase.product;
  const description = `${DIGITAL_PRODUCT_SALE_PREFIX} product ${product.id}`;
  const buyerCountry = charge.buyerCountry
    ? {
        buyerCountry: charge.buyerCountry,
        isInternational: charge.buyerCountry !== "IN",
      }
    : {};
  let payment: CreateEarningsParams["payment"];
  if (orderPayment) {
    const updatedLegs = await tx.paymentLeg.updateMany({
      where: { paymentId: orderPayment.id, source: "CARD" },
      data: { amountPaise: chargedPaise },
    });
    if (updatedLegs.count === 0) {
      await tx.paymentLeg.create({
        data: {
          paymentId: orderPayment.id,
          source: "CARD",
          amountPaise: chargedPaise,
          sourceRef: orderId,
        },
      });
    }
    payment = await settleOrderPayment(tx, orderPayment, {
      amount: chargedPaise,
      originalAmount: charge.originalAmount,
      taxAmount: charge.taxAmount,
      gstRegime: charge.gstRegime,
      ...buyerCountry,
      paymentMethod,
      capturedAt: new Date(),
      description,
      ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
    });
  } else {
    payment = await tx.payment.create({
      data: {
        userId: purchase.buyerId,
        appointmentId: null,
        amount: chargedPaise,
        originalAmount: charge.originalAmount,
        taxAmount: charge.taxAmount,
        gstRegime: charge.gstRegime,
        ...buyerCountry,
        currency: "INR",
        paymentMethod,
        paymentIntent: orderId,
        paymentGateway: "RAZORPAY",
        paymentStatus: "SUCCEEDED",
        capturedAt: new Date(),
        description,
        organizationId:
          product.visibility === "PUBLIC" ? null : product.organizationId,
        legs: cardLeg(chargedPaise, orderId),
        ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
      },
    });
  }
  await tx.digitalProductPurchase.updateMany({
    where: { id: purchase.id, paymentId: null },
    data: { paymentId: payment.id },
  });

  await createEarningsFromPayment({
    payment: {
      ...payment,
      appointment: {
        consultantProfile: { id: product.consultantProfileId },
        organizationId: product.organizationId,
        webinar: null,
        class: null,
      },
    },
    appointmentType: "DIGITAL_PRODUCT",
    // A product has no plan and so no team; the time is its capture.
    teamAt: payment.capturedAt ?? payment.createdAt,
    tx,
  });
  return { kind: "settled", paymentId: payment.id };
}

async function settleCapture(
  tx: Tx,
  orderId: string,
  gatewayPaymentId: string | undefined,
  notes: Record<string, string> | undefined,
  capturedPaise: number | undefined,
  method: string | undefined,
): Promise<CaptureOutcome | null> {
  const purchase: SettlingPurchase | null =
    await tx.digitalProductPurchase.findUnique({
      where: { gatewayOrderId: orderId },
      select: PURCHASE_SELECT,
    });
  if (!purchase) {
    Sentry.captureMessage(`[${RAIL}] captured order without row: ${orderId}`, {
      level: "error",
      tags: { subsystem: "payments" },
    });
    return refundOrphanCapture(tx, {
      orderId,
      gatewayPaymentId,
      notes,
      capturedPaise,
      method,
    });
  }

  // Settle only on gateway truth; without a captured amount stay PENDING.
  if (capturedPaise === undefined) return null;
  const chargedPaise = capturedPaise;
  if (!Number.isSafeInteger(chargedPaise) || chargedPaise <= 0) {
    throw new Error(`[${RAIL}] invalid charged amount for order ${orderId}`);
  }
  const charge = resolveStandaloneCharge(RAIL, orderId, chargedPaise, notes);
  const refundCapture = (paymentIntent: string, reason: string) =>
    stageRefund(tx, {
      paymentIntent,
      buyerId: purchase.buyerId,
      chargedPaise,
      charge,
      organizationId: null,
      gatewayPaymentId,
      method,
      reason,
    });
  if (chargedPaise !== purchase.amountPaise) {
    return refundCapture(
      orderId,
      `capture amount ${chargedPaise}p != expected ${purchase.amountPaise}p`,
    );
  }

  if (purchase.status === "SUCCEEDED" || purchase.status === "REFUNDED") {
    if (!gatewayPaymentId) return null;
    const duplicate = await isDuplicateCapture(tx, {
      purchaseId: purchase.id,
      settledBy: purchase.gatewayPaymentId,
      orderId,
      gatewayPaymentId,
    });
    return duplicate
      ? refundCapture(
          gatewayPaymentId,
          `duplicate capture on settled digital product order ${orderId}`,
        )
      : null;
  }

  const orderPayment = await tx.payment.findUnique({
    where: { paymentIntent: orderId },
  });
  const rejection = rejectionFor({
    purchase,
    orderPayment,
    orderId,
    gatewayPaymentId,
  });
  if (rejection)
    return refundCapture(rejection.paymentIntent, rejection.reason);

  const entitled = await tx.digitalProductPurchase.findFirst({
    where: {
      productId: purchase.productId,
      buyerId: purchase.buyerId,
      status: "SUCCEEDED",
      id: { not: purchase.id },
    },
    select: { id: true },
  });
  if (entitled) {
    return refundCapture(
      orderId,
      `capture on digital product order ${orderId}; the buyer already owns this product`,
    );
  }

  // Product lock before the purchase CAS: a file removal or takedown committed first is seen here.
  if (!(await lockDeliverableDigitalProduct(tx, purchase.productId))) {
    return refundCapture(
      orderId,
      `NO_DELIVERABLE capture on digital product order ${orderId}; the product has no verified file or was taken down`,
    );
  }

  // Expected prior status in WHERE: PENDING, or FAILED for a late retry.
  const claimed = await tx.digitalProductPurchase.updateMany({
    where: { id: purchase.id, status: purchase.status },
    data: {
      status: "SUCCEEDED",
      ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
    },
  });
  if (claimed.count === 0) return null;

  return settleProductSale(tx, {
    purchase,
    orderPayment,
    orderId,
    gatewayPaymentId,
    method,
    chargedPaise,
    charge,
  });
}

/** The receipt for the purchase this order would settle, rendered before the transaction. */
async function receiptForOrder(
  orderId: string,
): Promise<DigitalProductReceipt | null> {
  const purchase = await prisma.digitalProductPurchase.findUnique({
    where: { gatewayOrderId: orderId },
    select: {
      id: true,
      buyerId: true,
      productId: true,
      amountPaise: true,
      status: true,
    },
  });
  if (purchase?.status !== "PENDING" && purchase?.status !== "FAILED") {
    return null;
  }
  return prepareDigitalProductReceipt({
    purchaseId: purchase.id,
    buyerId: purchase.buyerId,
    productId: purchase.productId,
    amountPaise: purchase.amountPaise,
  });
}

export async function handleDigitalProductPurchaseSuccess(
  orderId: string,
  gatewayPaymentId?: string,
  notes?: Record<string, string>,
  /** Captured paise from the payment entity; absent, the purchase stays PENDING. */
  capturedPaise?: number,
  /** Razorpay's `method` for the capture. */
  method?: string,
): Promise<void> {
  // The receipt renders alongside the settled check; once settled it is null after one read.
  const [existing, receipt] = await Promise.all([
    prisma.payment.findUnique({
      where: { paymentIntent: orderId },
      select: {
        id: true,
        paymentStatus: true,
        amount: true,
        gatewayPaymentId: true,
      },
    }),
    receiptForOrder(orderId),
  ]);
  if (
    existing?.paymentStatus === "SUCCEEDED" &&
    (capturedPaise === undefined || capturedPaise === existing.amount) &&
    (!gatewayPaymentId ||
      !existing.gatewayPaymentId ||
      existing.gatewayPaymentId === gatewayPaymentId)
  ) {
    if (gatewayPaymentId && !existing.gatewayPaymentId) {
      await prisma.payment.updateMany({
        where: { id: existing.id, gatewayPaymentId: null },
        data: { gatewayPaymentId },
      });
    }
    return;
  }

  const { outcome, staged } = await prisma.$transaction(async (tx) => {
    const settled = await settleCapture(
      tx,
      orderId,
      gatewayPaymentId,
      notes,
      capturedPaise,
      method,
    );
    // The receipt obligation commits with the sale; a crash after commit leaves it staged.
    const emails: StagedRecipientEmail[] =
      settled?.kind === "settled"
        ? await stageDigitalProductReceipt(tx, receipt)
        : [];
    return { outcome: settled, staged: emails };
  });
  if (!outcome) return;
  // Post-commit and best effort, as the booking confirmation mints it.
  if (outcome.kind === "settled") {
    // Independent and both best effort, so neither waits on the other.
    await Promise.all([
      mintConsumerInvoiceBestEffort({ paymentId: outcome.paymentId }),
      flushDigitalProductReceipt(staged, EMAIL_BUDGET_MS.WEBHOOK),
    ]);
    return;
  }
  await refundStagedCapture(outcome, {
    orderId,
    dedupePrefix: "digital-product-capture",
  });
}

export async function handleDigitalProductPurchaseFailure(
  orderId: string,
): Promise<void> {
  // Only PENDING → FAILED; an out-of-order failure never unsettles a capture.
  await prisma.digitalProductPurchase.updateMany({
    where: { gatewayOrderId: orderId, status: "PENDING" },
    data: { status: "FAILED" },
  });
}
