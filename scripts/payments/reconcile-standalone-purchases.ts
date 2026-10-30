import {
  fetchRazorpayOrder,
  readRazorpayOrderHolding,
} from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";

const STANDALONE_ORDER_TYPES: ReadonlySet<string> = new Set([
  "recording_purchase",
  "digital_product_purchase",
]);

/**
 * Ask Razorpay what a standalone sale order holds and route a captured payment
 * to its handler exactly as the webhook would. Throws when the gateway cannot answer.
 */
export async function recoverStandaloneOrder(
  orderId: string,
): Promise<"captured" | "live" | "empty"> {
  const holding = await readRazorpayOrderHolding(orderId);
  if (holding.kind !== "captured") return holding.kind;
  const order = await fetchRazorpayOrder(orderId);
  if (!order) throw new Error("RAZORPAY_NOT_INITIALIZED");
  // The notes pick the handler; anything else would reach the booking pipeline.
  if (!STANDALONE_ORDER_TYPES.has(order.notes.type ?? "")) {
    throw new Error(`Order ${orderId} is not a standalone sale order`);
  }
  await routeCapturedPayment({
    orderId,
    notes: order.notes,
    amountPaise: holding.amountPaise,
    gatewayPaymentId: holding.paymentId,
  });
  return "captured";
}
