"use client";

import { useRouter } from "next/navigation";

import RazorpayCheckout, {
  type ExistingRazorpayOrder,
} from "@/app/checkout/components/RazorpayCheckout";
import { useToast } from "@/hooks/use-toast";

/**
 * #1775 P-1 — opens an order minted at approval (or trial request) in the
 * Razorpay sheet. Never calls `POST /api/checkout`; capture is confirmed by
 * the webhook as for every other order.
 */
export function PayExistingOrder({
  order,
  doneHref,
  description,
}: Readonly<{
  order: ExistingRazorpayOrder;
  doneHref: string;
  description: string;
}>) {
  const router = useRouter();
  const { toast } = useToast();
  return (
    <div className="[&>button]:w-full">
      <RazorpayCheckout
        existingOrder={order}
        description={description}
        onPaymentSuccess={() => {
          toast({
            title: "Payment received",
            description: "We're confirming your booking now.",
          });
          router.push(doneHref);
        }}
        onPaymentError={(error) => {
          toast({
            title: "Payment not completed",
            description:
              error.description ?? "The payment did not go through. Try again.",
            variant: "destructive",
          });
        }}
      />
    </div>
  );
}
