/**
 * POST /api/digital-products/purchases/[purchaseId]/verify — after a polling
 * timeout, ask Razorpay what the order holds and settle a capture the webhook
 * has not delivered yet, including a retry after a failed attempt on the same
 * order. A PENDING order whose every attempt failed is marked FAILED, as the
 * payment.failed webhook would; FAILED stays recoverable. A REFUNDED purchase
 * is never re-read.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import {
  FAILED_RECOVERY_MS,
  recoverStandaloneOrder,
} from "@/scripts/payments/reconcile-standalone-purchases";
import { handleDigitalProductPurchaseFailure } from "@/lib/payments/webhooks/digital-product-purchase";
import { reportSentryError } from "@/lib/observability/report";

type RouteParams = { params: Promise<{ purchaseId: string }> };

export async function POST(_request: Request, { params }: RouteParams) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const buyerId = auth.session.user.id;
  const limited = await applyRateLimit(moneyOpsLimiter, buyerId);
  if (limited) return limited;

  const { purchaseId } = await params;
  const purchase = await prisma.digitalProductPurchase.findFirst({
    where: { id: purchaseId, buyerId },
    select: { status: true, gatewayOrderId: true, createdAt: true },
  });
  if (!purchase) {
    return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
  }
  const recoverable =
    purchase.status === "PENDING" ||
    (purchase.status === "FAILED" &&
      Date.now() - purchase.createdAt.getTime() < FAILED_RECOVERY_MS);
  if (recoverable && purchase.gatewayOrderId) {
    try {
      const holding = await recoverStandaloneOrder(purchase.gatewayOrderId);
      if (purchase.status === "PENDING" && holding === "failed") {
        await handleDigitalProductPurchaseFailure(purchase.gatewayOrderId);
      }
    } catch (error) {
      reportSentryError(error, {
        subsystem: "payments",
        op: "digital-product.verify",
        expected: true,
        level: "warning",
        extra: { purchaseId },
      });
      return NextResponse.json(
        {
          error: "Could not confirm the payment yet",
          code: "GATEWAY_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
  }
  const current = await prisma.digitalProductPurchase.findUnique({
    where: { id: purchaseId },
    select: { id: true, status: true },
  });
  return NextResponse.json(
    { data: current },
    { headers: { "Cache-Control": "no-store" } },
  );
}
