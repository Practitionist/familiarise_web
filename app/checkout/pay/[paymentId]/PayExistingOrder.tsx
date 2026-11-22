"use client";

import { useRouter } from "next/navigation";

import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";
import RazorpayCheckout, {
  type ExistingRazorpayOrder,
} from "@/app/checkout/components/RazorpayCheckout";
import { useToast } from "@/hooks/use-toast";
import { checkoutSuccessPath } from "@/lib/payments/pay-link-href";

/**
 * #1775 P-1 — opens an order minted at approval (or trial request) in the
 * Razorpay sheet. Never calls `POST /api/checkout`; capture is confirmed by
 * the webhook as for every other order.
 */
export function PayExistingOrder({
  order,
  description,
  needsBuyerState,
  taxContext,
}: Readonly<{
  order: ExistingRazorpayOrder;
  description: string;
  needsBuyerState: boolean;
  taxContext: { billingStateCode: string | null; isInternational: boolean };
}>) {
  const router = useRouter();
  const { toast } = useToast();
  // The pay-link is always buyer-paid, so no org rail can waive the state.
  const billingState = useBillingState(taxContext, null);

  // The order's GST invoice needs the buyer's state, recorded before the sheet opens.
  const saveBuyerState = async (): Promise<boolean> => {
    if (!needsBuyerState) return true;
    if (!billingState.validate()) return false;
    let refusal = "Your billing state could not be saved. Try again.";
    try {
      const response = await fetch(
        `/api/checkout/pending/${encodeURIComponent(order.paymentId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(billingState.bodyField),
        },
      );
      if (response.ok) return true;
      const data: { error?: string } = await response.json().catch(() => ({}));
      refusal = data.error ?? refusal;
    } catch {
      // A network failure leaves the order unopened; the toast below says so.
    }
    toast({
      title: "Payment not started",
      description: refusal,
      variant: "destructive",
    });
    return false;
  };

  return (
    <div className="space-y-4">
      {needsBuyerState && <BillingStateSelect {...billingState.selectProps} />}
      <div className="[&>button]:w-full">
        <RazorpayCheckout
          existingOrder={order}
          description={description}
          onBeforeCheckout={saveBuyerState}
          onPaymentSuccess={() => {
            toast({
              title: "Payment received",
              description: "We're confirming your booking now.",
            });
            // The booking page would render the pre-capture state; this step waits for it.
            router.push(checkoutSuccessPath(order.orderId));
          }}
          onPaymentError={(error) => {
            toast({
              title: "Payment not completed",
              description:
                error.description ??
                "The payment did not go through. Try again.",
              variant: "destructive",
            });
          }}
        />
      </div>
    </div>
  );
}
