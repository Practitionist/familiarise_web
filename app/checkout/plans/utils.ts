import { useToast } from "@/hooks/use-toast";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";
import { PaymentGateway } from "@prisma/client";
import { loadStripe } from "@stripe/stripe-js";

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

    const errorMessages = {
      PAYMENT_CONFIG_ERROR: {
        title: "Payment System Error",
        description: "Payment system unavailable. Please contact support.",
      },
      PAYMENT_PROCESSING_ERROR: {
        title: "Payment Error",
        description: "Payment processing error. Please try again later.",
      },
      DATABASE_ERROR: {
        title: "System Error",
        description: "System error. Please try again.",
      },
      NOT_FOUND_ERROR: {
        title: "Not Found",
        description: errorMessage,
      },
      AVAILABILITY_ERROR: {
        title: "Booking Unavailable",
        description: errorMessage,
      },
      UNKNOWN_ERROR: {
        title: "Operation Failed",
        description: errorMessage,
      },
    };

    const error =
      errorMessages[errorType as keyof typeof errorMessages] ||
      errorMessages.UNKNOWN_ERROR;

    toast({
      title: error.title,
      description: error.description,
      variant: "destructive",
    });
  };
}

// Common API request logic for checkout
export async function makeCheckoutRequest(
  checkoutData: CheckoutInput,
): Promise<Response> {
  return fetch("/api/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(checkoutData),
  });
}

// Common success handling logic for different appointment types
export function createHandleCheckoutSuccess(
  toast: ReturnType<typeof useToast>["toast"],
  appointmentType: "CONSULTATION" | "WEBINAR" | "CLASS" | "SUBSCRIPTION",
) {
  return (data: any, isDevMode: boolean = false) => {
    const typeMessages = {
      CONSULTATION: {
        dev: "Your consultation has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the consultation.",
        successTitle: "✅ Consultation Booked Successfully!",
      },
      WEBINAR: {
        dev: "You're registered for the webinar. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        successTitle: "✅ Webinar Registration Successful!",
      },
      CLASS: {
        dev: "You're registered for the class. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        successTitle: "✅ Class Registration Successful!",
      },
      SUBSCRIPTION: {
        dev: "Your subscription has been activated. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to activate the subscription.",
        successTitle: "✅ Subscription Activated Successfully!",
      },
    };

    const messages = typeMessages[appointmentType];

    if (isDevMode) {
      // Development mode - direct booking success
      toast({
        title: messages.successTitle,
        description: data.skipPayment
          ? messages.dev
          : `Payment processed successfully. ${messages.dev}`,
        variant: "default",
      });

      // Redirect after a short delay
      setTimeout(() => {
        window.location.href = "/dashboard/consultee";
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

// Production workflow - payment gateway processing
export async function handleProductionCheckout(
  checkoutData: CheckoutInput,
  gateway: PaymentGateway,
  handleApiError: (errorData: any) => void,
  handleCheckoutSuccess: (data: any, isDevMode?: boolean) => void,
): Promise<void> {
  const response = await makeCheckoutRequest(checkoutData);

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(errorData);
    throw new Error(errorData.error || "Checkout failed");
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
    // Show success toast before redirecting
    handleCheckoutSuccess(data, false);

    // Small delay to let user see the toast before redirect
    setTimeout(async () => {
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
              return_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/checkout-success`,
            },
          });
          break;

        case "LEMON_SQUEEZY":
        case "XFLOW":
          if (data.checkoutUrl) {
            window.location.href = data.checkoutUrl;
          }
          break;
      }
    }, 1000);
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
  {
    name: "Lemon Squeezy",
    description: "Global payments in USD",
    gateway: "LEMON_SQUEEZY" as const,
  },
  {
    name: "Xflow",
    description: "Secure payments in USD",
    gateway: "XFLOW" as const,
  },
];

// Default success and error handlers for StripeCheckout component
export function createStripeCheckoutHandlers(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onPaymentSuccess: (response: any) => {
      toast({
        title: "Payment Successful",
        description: "Redirecting to success page...",
      });
      window.location.href = "/checkout/checkout-success";
    },
    onPaymentError: (error: any) => {
      toast({
        title: "Payment Failed",
        description: error.message || "An unknown error occurred",
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
        description: `Payment ID: ${response.razorpay_payment_id}`,
      });
      window.location.href = "/dashboard/consultee";
    },
    onPaymentError: (error: { description: string }) => {
      toast({
        title: "Payment Failed",
        description: error.description || "An unknown error occurred",
        variant: "destructive",
      });
    },
  };
}
