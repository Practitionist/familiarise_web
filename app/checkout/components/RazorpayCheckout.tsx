"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "../plans/utils";
import { CheckoutInput } from "@/schemas/checkout";
import { useState } from "react";

declare global {
  interface Window {
    Razorpay: any;
  }
}

interface RazorpayCheckoutProps {
  checkoutData: CheckoutInput;
  onPaymentSuccess: (response: any) => void;
  onPaymentError: (error: any) => void;
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
        body: JSON.stringify(checkoutData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        onPaymentError(errorData);
        return;
      }

      const data = await response.json();

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
        handler: function (response: any) {
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
      rzp.on("payment.failed", function (response: any) {
        onPaymentError(response.error);
      });
      rzp.open();
    } catch (error) {
      onPaymentError(error);
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
