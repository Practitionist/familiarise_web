import { useToast } from "@/hooks/use-toast";
import { getErrorToast } from "@/lib/errors/mapping/payment-error-toast-map";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";
import { PaymentGateway } from "@prisma/client";
import { loadStripe } from "@stripe/stripe-js";
import { getAppUrl } from "@/lib/url";

export function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(script);
  });
}

// Common error handling logic for checkout pages
export function createHandleApiError(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return (errorData: any) => {
    const errorMessage = errorData.error || "Operation failed";
    const errorType = errorData.errorType || "UNKNOWN_ERROR";

    const { title, description } = getErrorToast(errorType, errorMessage);

    toast({
      title,
      description,
      variant: "destructive",
    });
  };
}

// Common API request logic for checkout
export async function makeCheckoutRequest(
  checkoutData: CheckoutInput,
  isMockPayment: boolean = false,
): Promise<Response> {
  return fetch("/api/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...checkoutData, isMockPayment }),
  });
}

// Common success handling logic for different appointment types
export function createHandleCheckoutSuccess(
  toast: ReturnType<typeof useToast>["toast"],
  appointmentType: "CONSULTATION" | "WEBINAR" | "CLASS" | "SUBSCRIPTION",
) {
  return (
    data: any,
    isDevMode: boolean = false,
    isMockPayment: boolean = false,
  ) => {
    const typeMessages = {
      CONSULTATION: {
        dev: "Your consultation has been confirmed. Check your dashboard for details.",
        mock: "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the consultation.",
        successTitle: "✅ Consultation Booked Successfully!",
      },
      WEBINAR: {
        dev: "You're registered for the webinar. Check your dashboard for details.",
        mock: "Mock payment processed. Your webinar has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        successTitle: "✅ Webinar Booked Successfully!",
      },
      CLASS: {
        dev: "You're registered for the class. Check your dashboard for details.",
        mock: "Mock payment processed. Your class has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        successTitle: "✅ Class Booked Successfully!",
      },
      SUBSCRIPTION: {
        dev: "Your subscription has been activated. Check your dashboard for details.",
        mock: "Mock payment processed. Your subscription has been activated. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to activate the subscription.",
        successTitle: "✅ Subscription Activated Successfully!",
      },
    };

    const messages = typeMessages[appointmentType];

    if (isDevMode || isMockPayment) {
      // Development mode or mock payment - direct booking success
      toast({
        title: messages.successTitle,
        description: isMockPayment
          ? messages.mock
          : data.skipPayment
            ? messages.dev
            : `Payment processed successfully. ${messages.dev}`,
        variant: "default",
      });

      // Redirect after a short delay
      setTimeout(() => {
        window.location.href = "/dashboard";
      }, 2000);
    } else {
      // Production mode - payment initiated success
      toast({
        title: "🚀 Payment Initiated!",
        description: messages.prod,
        variant: "default",
      });
    }
  };
}

// Unified workflow - payment gateway processing with mock payment support
export async function handleUnifiedCheckout(
  checkoutData: CheckoutInput,
  gateway: PaymentGateway,
  handleApiError: (errorData: any) => void,
  handleCheckoutSuccess: (
    data: any,
    isDevMode?: boolean,
    isMockPayment?: boolean,
  ) => void,
  isMockPayment: boolean = false,
): Promise<void> {
  const response = await makeCheckoutRequest(checkoutData, isMockPayment);

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(errorData);
    return; // Toast already shown — don't throw to avoid double toast + console overlay
  }

  const rawData = await response.json();

  // Validate response using schema
  const validationResult = checkoutResponseSchema.safeParse(rawData);
  if (!validationResult.success) {
    console.error("Invalid checkout response:", validationResult.error);
    throw new Error("Invalid response from server");
  }

  const data = validationResult.data;

  if (data.success) {
    // Check if this is a mock payment or skip payment scenario
    if (data.skipPayment || isMockPayment) {
      // Mock payment or dev mode - direct success
      handleCheckoutSuccess(data, data.skipPayment, isMockPayment);
    } else {
      // Show success toast before redirecting
      handleCheckoutSuccess(data, false, false);

      // Small delay to let user see the toast before redirect
      setTimeout(async () => {
        try {
          // Handle gateway-specific responses
          switch (gateway) {
            case "STRIPE":
              const stripeInstance = await loadStripe(
                process.env.NEXT_PUBLIC_STRIPE_KEY!,
              );
              if (!stripeInstance) {
                throw new Error("Failed to load Stripe");
              }
              await stripeInstance.confirmPayment({
                clientSecret: data.clientSecret!,
                confirmParams: {
                  return_url: `${getAppUrl()}/checkout/checkout-success`,
                },
              });
              break;

            // TODO(#312/#334): Add Lemon Squeezy and XFlow cases when webhook handlers are implemented
          }
        } catch (err) {
          console.error("Payment confirmation error:", err);
          handleApiError({
            error:
              err instanceof Error
                ? err.message
                : "Payment confirmation failed",
            errorType: "PAYMENT_ERROR",
          });
        }
      }, 1000);
    }
  } else {
    handleApiError({ error: data.error, errorType: data.errorType });
  }
}

// Gateway configuration for UI rendering
export const paymentGateways = [
  {
    name: "Stripe",
    description: "International payments in USD",
    gateway: "STRIPE" as const,
  },
  {
    name: "Razorpay",
    description: "Indian payments in INR",
    gateway: "RAZORPAY" as const,
  },
  // TODO: Add Lemon Squeezy and XFlow when webhook appointment creation is implemented
];

// Default success and error handlers for StripeCheckout component
export function createStripeCheckoutHandlers(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onPaymentSuccess: (response: any) => {
      toast({
        title: "Payment Successful",
        description:
          "Your payment has been confirmed! Redirecting to your confirmation page...",
      });
      window.location.href = "/checkout/checkout-success";
    },
    onPaymentError: (error: any) => {
      const errorMessage =
        error.message || error.code || "An unexpected error occurred";
      const userFriendlyMessage =
        errorMessage.includes("card") || errorMessage.includes("payment_method")
          ? "Your card was declined. Please check your card details or try a different payment method."
          : errorMessage.includes("insufficient")
            ? "Your card has insufficient funds. Please use a different card or payment method."
            : errorMessage.includes("expired")
              ? "Your card has expired. Please use a different card."
              : errorMessage.includes("network")
                ? "Connection error. Please check your internet connection and try again."
                : `Payment failed: ${errorMessage}. Please try again or contact your bank if the problem persists.`;

      toast({
        title: "Payment Failed",
        description: userFriendlyMessage,
        variant: "destructive",
      });
    },
  };
}

// Default success and error handlers for RazorpayCheckout component
export function createRazorpayCheckoutHandlers(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onPaymentSuccess: (response: { razorpay_payment_id: string }) => {
      toast({
        title: "Payment Successful",
        description: `Your payment has been confirmed! Payment ID: ${response.razorpay_payment_id}. Redirecting to your dashboard...`,
      });
      window.location.href = "/dashboard";
    },
    onPaymentError: (error: {
      description: string;
      code?: string;
      reason?: string;
    }) => {
      const errorDescription =
        error.description || error.reason || "An unexpected error occurred";
      const userFriendlyMessage =
        errorDescription.includes("payment failed") ||
        errorDescription.includes("declined")
          ? "Your payment was declined by the bank. Please check your payment details or try a different payment method."
          : errorDescription.includes("cancelled") ||
              errorDescription.includes("canceled")
            ? "Payment was cancelled. You can try again when you're ready."
            : errorDescription.includes("insufficient")
              ? "Insufficient funds in your account. Please use a different payment method."
              : errorDescription.includes("timeout") ||
                  errorDescription.includes("network")
                ? "Payment timed out due to a connection issue. Please check your internet and try again."
                : errorDescription.includes("invalid")
                  ? "Invalid payment details. Please check your information and try again."
                  : `${errorDescription}. Please try again or contact your bank for assistance.`;

      toast({
        title: "Payment Failed",
        description: userFriendlyMessage,
        variant: "destructive",
      });
    },
  };
}
