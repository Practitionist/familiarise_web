"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "../plans/utils";
import { CheckoutInput } from "@/schemas/checkout";
import { useRef, useState } from "react";
import { mintClientIdempotencyKey } from "@/app/checkout/plans/utils";

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayPaymentError {
  description?: string;
  code?: string;
  reason?: string;
  message?: string;
}

interface RazorpayFailedResponse {
  error: RazorpayPaymentError;
}

interface RazorpayOptions {
  key: string | undefined;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayPaymentResponse) => void;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  theme?: {
    color: string;
  };
}

interface RazorpayInstance {
  on: (event: string, handler: (response: RazorpayFailedResponse) => void) => void;
  open: () => void;
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

interface RazorpayCheckoutProps {
  checkoutData: CheckoutInput;
  onPaymentSuccess: (response: RazorpayPaymentResponse | { message: string }) => void;
  onPaymentError: (error: RazorpayPaymentError) => void;
  disabled?: boolean;
  userName?: string;
  userEmail?: string;
  userPhone?: string;
  description?: string;
}

export default function RazorpayCheckout({
  checkoutData,
  onPaymentSuccess,
  onPaymentError,
  disabled,
  userName,
  userEmail,
  userPhone,
  description,
}: RazorpayCheckoutProps) {
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  // #828 — stable per-mount; the server dedupes retries on this key.
  const idempotencyKeyRef = useRef(mintClientIdempotencyKey());

  const handleCheckout = async () => {
    setIsProcessing(true);
    try {
      const isLoaded = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      );

      if (!isLoaded) {
        toast({
          title: "Payment System Not Loading",
          description:
            "The Razorpay payment system couldn't load. This may be due to a slow connection or ad blocker. Please check your internet connection, disable any ad blockers, and try again.",
          variant: "destructive",
        });
        return;
      }

      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...checkoutData,
          clientIdempotencyKey: idempotencyKeyRef.current,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        onPaymentError({
          description: errorData.error || "Payment request failed",
          code: errorData.errorType,
        });
        return;
      }

      const data = await response.json();

      if (!data.success) {
        onPaymentError({
          description: data.error || "Payment initialization failed",
          code: data.errorType,
        });
        return;
      }

      // FIX #520: Zero-amount payments (credits covered full cost) — no gateway needed
      if (data.isZeroAmountPayment) {
        onPaymentSuccess({
          message:
            data.message ||
            "Payment completed via referral credits. Appointment booked successfully.",
        });
        return;
      }

      if (!process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) {
        toast({
          title: "Payment System Configuration Error",
          description:
            "The Razorpay payment system is not properly configured on this website. This is a technical issue on our end. Please contact support for assistance, or try a different payment method.",
          variant: "destructive",
        });
        return;
      }

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: data.paymentIntent.amount,
        currency: data.paymentIntent.currency,
        name: "Familiarise",
        description: description || "Service Payment",
        order_id: data.paymentIntent.id,
        handler: async function (response: RazorpayPaymentResponse) {
          // H2 FIX: Verify Razorpay signature server-side before signaling success
          try {
            const verifyRes = await fetch("/api/checkout/verify-signature", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            if (!verifyRes.ok) {
              const err = await verifyRes.json();
              console.error("Payment signature verification failed:", err);
              onPaymentError({
                description:
                  "Payment verification failed. Our team will review this transaction.",
                code: "VERIFICATION_FAILED",
              });
              return;
            }
          } catch (verifyErr) {
            // Network failure — don't block; webhook is the ultimate authority
            console.error("Signature verification request failed:", verifyErr);
          }
          onPaymentSuccess(response);
        },
        ...(userName || userEmail || userPhone
          ? {
              prefill: {
                ...(userName && { name: userName }),
                ...(userEmail && { email: userEmail }),
                ...(userPhone && { contact: userPhone }),
              },
            }
          : {}),
        theme: {
          color: "#2563EB", // Familiarise brand blue
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", function (response: RazorpayFailedResponse) {
        onPaymentError(response.error);
      });
      rzp.open();
    } catch (error) {
      onPaymentError({
        description: error instanceof Error ? error.message : "An unexpected error occurred",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Button onClick={handleCheckout} disabled={isProcessing || disabled}>
      {isProcessing ? "Processing..." : "Pay with Razorpay"}
    </Button>
  );
}
