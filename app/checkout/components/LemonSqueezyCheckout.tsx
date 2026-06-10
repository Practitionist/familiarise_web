"use client";

import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";
import { mintClientIdempotencyKey } from "@/app/checkout/plans/utils";

interface LemonSqueezyCheckoutProps {
  input: CheckoutInput;
  onSuccess: () => void;
  onError: (error: string) => void;
}

// Lemon Squeezy checkout configuration
interface LemonSqueezyEventData {
  message?: string;
}

declare global {
  interface Window {
    createLemonSqueezy: () => {
      Setup: (options: {
        eventHandler: (event: { event: string; data?: LemonSqueezyEventData }) => void;
      }) => void;
      Url: {
        Open: (checkoutUrl: string) => void;
      };
    };
  }
}

const LemonSqueezyCheckout: React.FC<LemonSqueezyCheckoutProps> = ({
  input,
  onSuccess,
  onError,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  // #828 — stable per-mount; the server dedupes retries on this key.
  const idempotencyKeyRef = useRef(mintClientIdempotencyKey());
  const { toast } = useToast();

  const loadLemonSqueezyScript = (): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      // Check if Lemon Squeezy is already loaded
      if (typeof window.createLemonSqueezy === "function") {
        resolve(true);
        return;
      }

      const script = document.createElement("script");
      script.src = "https://app.lemonsqueezy.com/js/lemon.js";
      script.onload = () => resolve(true);
      script.onerror = () =>
        reject(new Error("Failed to load Lemon Squeezy SDK"));
      document.body.appendChild(script);
    });
  };

  const handleLemonSqueezyCheckout = async () => {
    try {
      setIsProcessing(true);

      // Load Lemon Squeezy SDK
      await loadLemonSqueezyScript();

      // Make API call to create checkout session
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...input,
          paymentGateway: "LEMON_SQUEEZY",
          clientIdempotencyKey: idempotencyKeyRef.current,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to create checkout session",
        );
      }

      const data = await response.json();
      const validatedData = checkoutResponseSchema.parse(data);

      if (validatedData.success && validatedData.checkoutUrl) {
        // Initialize Lemon Squeezy
        const LemonSqueezy = window.createLemonSqueezy();

        LemonSqueezy.Setup({
          eventHandler: (event) => {
            if (event.event === "Checkout.Success") {
              setIsProcessing(false);
              onSuccess();
              toast({
                title: "Payment Successful",
                description: "Your payment has been processed successfully!",
              });
            } else if (event.event === "Checkout.Closed") {
              setIsProcessing(false);
              // Don't show error for user-initiated close
            } else if (event.event === "Checkout.Error") {
              setIsProcessing(false);
              const errorMessage = event.data?.message || "Payment failed";
              onError(errorMessage);
              toast({
                title: "Payment Failed",
                description: errorMessage,
                variant: "destructive",
              });
            }
          },
        });

        // Open checkout overlay
        LemonSqueezy.Url.Open(validatedData.checkoutUrl);
      } else {
        throw new Error("No checkout URL received from server");
      }
    } catch (error) {
      setIsProcessing(false);
      console.error("Lemon Squeezy checkout error:", error);

      let errorMessage = "Payment processing failed";
      if (error instanceof Error) {
        if (error.message.includes("Network")) {
          errorMessage =
            "Network error. Please check your connection and try again.";
        } else if (error.message.includes("Failed to load")) {
          errorMessage = "Failed to load payment processor. Please try again.";
        } else if (error.message.includes("not implemented")) {
          errorMessage =
            "Lemon Squeezy payments are not available yet. Please try another payment method.";
        } else {
          errorMessage = error.message;
        }
      }

      onError(errorMessage);
      toast({
        title: "Payment Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const handleSkipPayment = () => {
    toast({
      title: "Payment Skipped",
      description: "Payment skipped for development mode",
    });
    onSuccess();
  };

  // Development mode skip payment
  if (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_SKIP_PAYMENT === "true"
  ) {
    return (
      <Button
        onClick={handleSkipPayment}
        className="w-full bg-yellow-600 hover:bg-yellow-700"
        disabled={isProcessing}
      >
        Skip Payment (Dev Mode)
      </Button>
    );
  }

  return (
    <Button
      onClick={handleLemonSqueezyCheckout}
      disabled={isProcessing}
      className="w-full bg-yellow-500 hover:bg-yellow-600 text-white"
    >
      {isProcessing ? (
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          Processing...
        </div>
      ) : (
        <>
          <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
          </svg>
          Pay with Lemon Squeezy
        </>
      )}
    </Button>
  );
};

export default LemonSqueezyCheckout;
