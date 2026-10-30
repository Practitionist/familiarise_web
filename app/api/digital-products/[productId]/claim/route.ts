/**
 * POST /api/digital-products/[productId]/claim — take a free product. The
 * claim is a SUCCEEDED purchase of 0 paise with no order, Payment, invoice or
 * earnings; the partial unique on (productId, buyerId) refuses a second one.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, checkoutLimiter } from "@/lib/rate-limit";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import { notifyDigitalProductPurchase } from "@/lib/digital-products/purchase-email";
import {
  checkProductForSale,
  SALE_REFUSAL_STATUS,
} from "@/lib/digital-products/sale";
import {
  BookingLockUnavailableError,
  DigitalProductPurchaseInProgressError,
  lockDigitalProductPurchase,
} from "@/utils/appointmentlock";

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
        { error: "This product is not available", code: sale.code },
        { status: SALE_REFUSAL_STATUS[sale.code] },
      );
    }
    if (sale.product.pricePaise !== 0) {
      return NextResponse.json(
        { error: "This product is paid; buy it instead", code: "PAID_PRODUCT" },
        { status: 409 },
      );
    }

    const claimed = await lockDigitalProductPurchase(
      productId,
      buyerId,
      async () => {
        const owned = await prisma.digitalProductPurchase.findFirst({
          where: { productId, buyerId, status: "SUCCEEDED" },
          select: { id: true },
        });
        if (owned) return null;
        return prisma.digitalProductPurchase.create({
          data: { productId, buyerId, amountPaise: 0, status: "SUCCEEDED" },
          select: { id: true },
        });
      },
    );
    if (!claimed) return alreadyOwned();
    await notifyDigitalProductPurchase(
      { id: claimed.id },
      EMAIL_BUDGET_MS.REQUEST,
    );
    return NextResponse.json(
      { data: { purchaseId: claimed.id } },
      { status: 201 },
    );
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
    console.error("Error claiming digital product:", error);
    return NextResponse.json(
      { error: "Failed to claim product" },
      { status: 500 },
    );
  }
}
