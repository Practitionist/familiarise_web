"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";

interface XFlowCheckoutProps {
  input: CheckoutInput;
  onSuccess: () => void;
  onError: (error: string) => void;
}

// XFlow payment gateway configuration for African markets
interface XFlowCallbackResponse {
  status: string;
  message?: string;
}

declare global {
  interface Window {
    XFlow?: {
      checkout: (options: {
        public_key: string;
        amount: number;
        currency: string;
        email: string;
        callback: (response: XFlowCallbackResponse) => void;
        onClose: () => void;
      }) => void;
    };
  }
}

const XFlowCheckout: React.FC<XFlowCheckoutProps> = ({
  input,
  onSuccess,
  onError,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const { toast } = useToast();

  // Load XFlow script dynamically
  const loadXFlowScript = (): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      // Check if XFlow is already loaded
      if (typeof window.XFlow === "object") {
        resolve(true);
        return;
      }

      const script = document.createElement("script");
      script.src = "https://js.xflow.com/v1/xflow.js"; // Example URL - adjust based on actual XFlow SDK
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error("Failed to load XFlow SDK"));
      document.head.appendChild(script);
    });
  };

  const handleXFlowPayment = async () => {
    setIsProcessing(true);

    try {
      // Development mode skip payment
      if (
        process.env.NODE_ENV === "development" &&
        process.env.NEXT_PUBLIC_SKIP_PAYMENT === "true"
      ) {
        toast({
          title: "Development Mode",
          description: "Payment skipped in development mode",
        });
        onSuccess();
        return;
      }

      // Make checkout request to backend
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...input,
          gateway: "XFLOW",
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Checkout request failed");
      }

      const data = await response.json();
      const validatedData = checkoutResponseSchema.parse(data);

      if (validatedData.success && validatedData.checkoutUrl) {
        // Redirect to XFlow checkout page
        window.location.href = validatedData.checkoutUrl;
      } else if (validatedData.success && validatedData.clientSecret) {
        // Handle embedded XFlow checkout if supported
        await loadXFlowScript();

        if (window.XFlow) {
          window.XFlow.checkout({
            public_key: process.env.NEXT_PUBLIC_XFLOW_PUBLIC_KEY || "",
            amount: validatedData.amount || 0,
            currency: validatedData.currency || "NGN", // Default to Nigerian Naira for XFlow
            email: "", // Will be provided by backend in actual implementation
            callback: (response) => {
              if (response.status === "success") {
                toast({
                  title: "Payment Successful",
                  description: "Your payment has been processed successfully",
                });
                onSuccess();
              } else {
                throw new Error(response.message || "Payment failed");
              }
            },
            onClose: () => {
              setIsProcessing(false);
            },
          });
        } else {
          throw new Error("XFlow SDK not available");
        }
      } else {
        const errorMessage = !validatedData.success
          ? validatedData.error
          : "Failed to create checkout session";
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error("XFlow checkout error:", error);

      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred during checkout";

      toast({
        title: "Payment Error",
        description: errorMessage,
        variant: "destructive",
      });

      onError(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Button
      onClick={handleXFlowPayment}
      disabled={isProcessing}
      className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
    >
      {isProcessing ? (
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
          Processing...
        </div>
      ) : (
        "Pay with XFlow"
      )}
    </Button>
  );
};

export default XFlowCheckout;
