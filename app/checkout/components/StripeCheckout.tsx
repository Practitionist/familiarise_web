"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";
import { loadStripe } from "@stripe/stripe-js";
import { useState } from "react";

// Initialize Stripe with publishable key
const stripeKey = process.env.NEXT_PUBLIC_STRIPE_KEY;
console.log("Stripe key exists:", !!stripeKey);
const stripePromise = stripeKey ? loadStripe(stripeKey) : null;

interface StripeCheckoutProps {
  checkoutData: CheckoutInput;
  onPaymentSuccess: (response: any) => void;
  onPaymentError: (error: any) => void;
}

export default function StripeCheckout({
  checkoutData,
  onPaymentSuccess,
  onPaymentError,
}: StripeCheckoutProps) {
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleCheckout = async () => {
    setIsProcessing(true);
    try {
      if (!stripePromise) {
        const errorMsg = !stripeKey 
          ? "Stripe publishable key (NEXT_PUBLIC_STRIPE_KEY) is not configured" 
          : "Stripe failed to initialize";
        toast({
          title: "Configuration Error",
          description: errorMsg,
          variant: "destructive",
        });
        onPaymentError({ message: errorMsg });
        return;
      }

      const stripe = await stripePromise;

      if (!stripe) {
        toast({
          title: "Error",
          description: "Stripe failed to load. Please check your internet connection or disable ad blockers.",
          variant: "destructive",
        });
        onPaymentError({ message: "Stripe failed to load" });
        return;
      }

      // Make API call to create checkout session/payment intent
      console.log("Making checkout request with data:", checkoutData);
      
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(checkoutData),
      });

      console.log("Response status:", response.status);

      if (!response.ok) {
        const errorData = await response.json();
        console.error("API error response:", errorData);
        onPaymentError(errorData);
        return;
      }

      const rawData = await response.json();
      console.log("Checkout API response:", rawData);
      
      // Validate response using schema
      const validationResult = checkoutResponseSchema.safeParse(rawData);
      if (!validationResult.success) {
        console.error("Invalid checkout response:", validationResult.error);
        console.error("Raw response data:", rawData);
        onPaymentError({ message: "Invalid response from server" });
        return;
      }

      const data = validationResult.data;

      if (!data.success) {
        onPaymentError({ message: data.error, errorType: data.errorType });
        return;
      }

      // Check if payment should be skipped (development mode)
      if (data.skipPayment) {
        onPaymentSuccess({ message: "Payment skipped in development mode" });
        return;
      }

      // Handle payment based on what the server returns
      if (data.checkoutUrl) {
        // For hosted checkout sessions, redirect directly
        window.location.href = data.checkoutUrl;
      } else if (data.paymentIntent?.client_secret) {
        // For Stripe, client_secret now contains the checkout URL
        if (data.paymentIntent.client_secret.startsWith('https://checkout.stripe.com')) {
          window.location.href = data.paymentIntent.client_secret;
        } else {
          // Fallback for other formats
          window.location.href = data.paymentIntent.client_secret;
        }
      } else if (data.clientSecret) {
        // Direct client_secret field
        if (data.clientSecret.startsWith('https://checkout.stripe.com')) {
          window.location.href = data.clientSecret;
        } else {
          // Legacy Payment Intent format (shouldn't happen with new implementation)
          onPaymentError({
            message: "Payment method requires additional setup",
          });
        }
      } else {
        onPaymentError({
          message: "No payment method available in response",
        });
      }
    } catch (error) {
      onPaymentError({
        message: error instanceof Error ? error.message : "An unknown error occurred",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Button onClick={handleCheckout} disabled={isProcessing}>
      {isProcessing ? "Processing..." : "Pay with Stripe"}
    </Button>
  );
}
