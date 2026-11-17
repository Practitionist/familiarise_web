/**
 * POST /api/digital-products/[productId]/claim — take a free product. The
 * claim is a SUCCEEDED purchase of 0 paise with no order, Payment, invoice or
 * earnings; the partial unique on (productId, buyerId) refuses a second one.
 * A product with nothing deliverable under its row lock is refused with 409.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, checkoutLimiter } from "@/lib/rate-limit";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  flushDigitalProductReceipt,
  prepareDigitalProductReceipt,
  stageDigitalProductReceipt,
} from "@/lib/digital-products/purchase-email";
import { ownProductNotice } from "@/lib/digital-products/constants";
import {
  checkProductForSale,
  SALE_REFUSAL_STATUS,
} from "@/lib/digital-products/sale";
import { lockDeliverableDigitalProduct } from "@/lib/digital-products/product-lock";
import {
  BookingLockUnavailableError,
  DigitalProductPurchaseInProgressError,
  lockDigitalProductPurchase,
} from "@/utils/appointmentlock";
import { reportSentryError } from "@/lib/observability/report";

type RouteParams = { params: Promise<{ productId: string }> };

const alreadyOwned = () =>
  NextResponse.json(
    { error: "You already own this product", code: "ALREADY_ENTITLED" },
    { status: 400 },
  );

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
              ? ownProductNotice(true)
              : "This product is not available",
          code: sale.code,
        },
        { status: SALE_REFUSAL_STATUS[sale.code] },
      );
    }
    if (sale.product.pricePaise !== 0) {
      return NextResponse.json(
        { error: "This product is paid; buy it instead", code: "PAID_PRODUCT" },
        { status: 409 },
      );
    }

    const purchaseId = randomUUID();
    const receipt = await prepareDigitalProductReceipt({
      purchaseId,
      buyerId,
      productId,
      amountPaise: 0,
    });
    const claimed = await lockDigitalProductPurchase(productId, buyerId, () =>
      prisma.$transaction(async (tx) => {
        // Product lock before the purchase row: a racing last-file removal or takedown is seen here.
        if (!(await lockDeliverableDigitalProduct(tx, productId))) {
          return "NO_DELIVERABLE" as const;
        }
        const owned = await tx.digitalProductPurchase.findFirst({
          where: { productId, buyerId, status: "SUCCEEDED" },
          select: { id: true },
        });
        if (owned) return null;
        await tx.digitalProductPurchase.create({
          data: {
            id: purchaseId,
            productId,
            buyerId,
            amountPaise: 0,
            status: "SUCCEEDED",
          },
          select: { id: true },
        });
        // The receipt obligation commits with the claim.
        return stageDigitalProductReceipt(tx, receipt);
      }),
    );
    if (!claimed) return alreadyOwned();
    if (claimed === "NO_DELIVERABLE") {
      return NextResponse.json(
        {
          error: "This product has no file to deliver",
          code: "NO_DELIVERABLE",
        },
        { status: 409 },
      );
    }
    await flushDigitalProductReceipt(claimed, EMAIL_BUDGET_MS.REQUEST);
    return NextResponse.json({ data: { purchaseId } }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return alreadyOwned();
    }
    if (
      error instanceof DigitalProductPurchaseInProgressError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    reportSentryError(error, {
      subsystem: "payments",
      op: "digital-product.claim",
      expected: false,
    });
    return NextResponse.json(
      { error: "Failed to claim product" },
      { status: 500 },
    );
  }
}
