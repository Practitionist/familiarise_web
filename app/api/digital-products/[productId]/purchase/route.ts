/**
 * POST /api/digital-products/[productId]/purchase — mint (or resume) the
 * Razorpay order for one paid digital product. The capture settles it through
 * handleDigitalProductPurchaseSuccess, idempotent per gatewayOrderId.
 */
import { refusalJson } from "@/lib/errors/refusal-json";
import { NextResponse } from "next/server";
import type { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, checkoutLimiter } from "@/lib/rate-limit";
import {
  cancelRazorpayOrder,
  createRazorpayOrder,
} from "@/lib/payments/core/razorpay";
import { savedCardCustomerId } from "@/lib/payments/core/saved-card-customer";
import { deriveDigitalProductChargeForBuyer } from "@/lib/payments/pricing/digital-product-price";
import type { digitalProductChargeNotesSchema } from "@/lib/payments/webhooks/digital-product-purchase";
import { ownProductNotice } from "@/lib/digital-products/constants";
import {
  checkProductForSale,
  SALE_REFUSAL_STATUS,
} from "@/lib/digital-products/sale";
import {
  BookingLockUnavailableError,
  DigitalProductPurchaseInProgressError,
  lockDigitalProductPurchase,
} from "@/utils/appointmentlock";
import { reportSentryError } from "@/lib/observability/report";

type RouteParams = { params: Promise<{ productId: string }> };

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const buyerId = auth.session.user.id;
    const limited = await applyRateLimit(checkoutLimiter, buyerId);
    if (limited) return limited;

    const { productId } = await params;
    const sale = await checkProductForSale(productId, auth.session.user);
    if (!sale.ok) {
      return NextResponse.json(
        {
          error:
            sale.code === "OWN_PRODUCT"
              ? ownProductNotice(false)
              : "This product is not available to buy",
          code: sale.code,
        },
        { status: SALE_REFUSAL_STATUS[sale.code] },
      );
    }
    if (sale.product.pricePaise <= 0) {
      return NextResponse.json(
        {
          error: "This product is free; claim it instead",
          code: "FREE_PRODUCT",
        },
        { status: 409 },
      );
    }

    // Resolved before the lock so a slow Customer call holds nothing.
    const [customerId, { buyerCountry, derived }] = await Promise.all([
      savedCardCustomerId(buyerId),
      deriveDigitalProductChargeForBuyer({
        pricePaise: sale.product.pricePaise,
        buyerId,
      }),
    ]);

    // Read, mint and create under one lock so a second caller resumes, never re-mints.
    const outcome = await lockDigitalProductPurchase(
      productId,
      buyerId,
      async () => {
        const [owned, pending] = await Promise.all([
          prisma.digitalProductPurchase.findFirst({
            where: { productId, buyerId, status: "SUCCEEDED" },
            select: { id: true },
          }),
          prisma.digitalProductPurchase.findFirst({
            where: { productId, buyerId, status: "PENDING" },
            orderBy: { createdAt: "desc" },
            select: { id: true, gatewayOrderId: true, amountPaise: true },
          }),
        ]);
        if (owned) return { kind: "owned" as const };
        if (
          pending?.gatewayOrderId &&
          Number(pending.amountPaise) === derived.amount
        ) {
          return {
            kind: "resumed" as const,
            purchaseId: pending.id,
            orderId: pending.gatewayOrderId,
            amount: pending.amountPaise,
            currency: "INR",
          };
        }
        if (pending?.gatewayOrderId) {
          // The price moved since this order was minted: retire it, then mint at today's price.
          const superseded = await prisma.digitalProductPurchase.updateMany({
            where: { id: pending.id, status: "PENDING" },
            data: { status: "FAILED" },
          });
          if (
            superseded.count === 0 &&
            (await prisma.digitalProductPurchase.findFirst({
              where: { productId, buyerId, status: "SUCCEEDED" },
              select: { id: true },
            }))
          ) {
            return { kind: "owned" as const };
          }
        }

        // The capture handler splits the charge from these; they sum to `amount`.
        const metadata: z.input<typeof digitalProductChargeNotesSchema> = {
          type: "digital_product_purchase",
          productId,
          userId: buyerId,
          originalAmountPaise: String(derived.originalAmount),
          taxAmountPaise: String(derived.taxAmount),
          buyerCountry,
          gstRegime: derived.gstRegime,
        };
        const order = await createRazorpayOrder({
          amount: derived.amount,
          currency: "INR",
          paymentGateway: "RAZORPAY",
          metadata,
          customerId,
        });

        try {
          const purchase = await prisma.$transaction(async (tx) => {
            // A same-value write that matches only while the product is for sale at the charged
            // price; it locks the row that archive, take-down, delete and price edits write.
            const forSale = await tx.digitalProduct.updateMany({
              where: {
                id: productId,
                status: "PUBLISHED",
                takenDownAt: null,
                pricePaise: sale.product.pricePaise,
              },
              data: { status: "PUBLISHED" },
            });
            if (forSale.count === 0) {
              const listed = await tx.digitalProduct.findFirst({
                where: {
                  id: productId,
                  status: "PUBLISHED",
                  takenDownAt: null,
                },
                select: { id: true },
              });
              return listed ? ("price_changed" as const) : null;
            }
            return tx.digitalProductPurchase.create({
              data: {
                productId,
                buyerId,
                gatewayOrderId: order.id,
                amountPaise: derived.amount,
                status: "PENDING",
              },
              select: { id: true },
            });
          });
          if (purchase === null || purchase === "price_changed") {
            await cancelRazorpayOrder(order.id).catch((cancelError: unknown) =>
              console.error("Failed to cancel stranded order:", cancelError),
            );
            return {
              kind: purchase ?? ("not_for_sale" as const),
            };
          }
          return {
            kind: "minted" as const,
            purchaseId: purchase.id,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            ...(order.customerId ? { customerId: order.customerId } : {}),
          };
        } catch (rowError) {
          // A payable order must not outlive its row.
          console.error(
            "Failed to persist digital product purchase:",
            rowError,
          );
          await cancelRazorpayOrder(order.id).catch((cancelError: unknown) =>
            console.error("Failed to cancel stranded order:", cancelError),
          );
          throw rowError;
        }
      },
    );

    if (outcome.kind === "not_for_sale") {
      return NextResponse.json(
        { error: "This product is not available to buy", code: "NOT_FOR_SALE" },
        { status: SALE_REFUSAL_STATUS.NOT_FOR_SALE },
      );
    }
    if (outcome.kind === "price_changed") {
      return NextResponse.json(
        {
          error:
            "The price of this product just changed. Reload the page to see the new price.",
          code: "PRICE_CHANGED",
        },
        { status: 409 },
      );
    }
    if (outcome.kind === "owned") {
      return NextResponse.json(
        { error: "You already own this product", code: "ALREADY_ENTITLED" },
        { status: 400 },
      );
    }
    const { kind, ...data } = outcome;
    return NextResponse.json(
      { data },
      { status: kind === "minted" ? 201 : 200 },
    );
  } catch (error) {
    if (
      error instanceof DigitalProductPurchaseInProgressError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    // A set but unusable PLATFORM_GSTIN refuses pricing with a typed 503.
    const refused = refusalJson(error);
    if (refused) return refused;
    reportSentryError(error, {
      subsystem: "payments",
      op: "digital-product.purchase",
      expected: false,
    });
    return NextResponse.json(
      { error: "Failed to start purchase" },
      { status: 500 },
    );
  }
}
