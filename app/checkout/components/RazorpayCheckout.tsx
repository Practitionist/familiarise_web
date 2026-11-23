"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "../plans/utils";
import { CheckoutInput } from "@/schemas/checkout";
import { useRef, useState } from "react";
import {
  buildCheckoutOptions,
  holdTimeoutSeconds,
} from "@/lib/payments/client/checkout-options";
import { useCheckoutFlags } from "./CheckoutFlags";
import {
  busyRetryToast,
  checkoutNeedsGateway,
  fetchCheckoutWithBusyRetry,
  useCheckoutAttemptKey,
  reportPaymentsError,
} from "@/app/checkout/plans/utils";
import { fetchWithIdentity } from "@/lib/auth/identity-header";

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayPaymentError {
  description?: string;
  code?: string;
  /** The route's coarse bucket when `code` is a rule code with no toast of its own. */
  errorType?: string;
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
  /**
   * Closing the gateway sheet fires neither `handler` nor `payment.failed`, so
   * without this the page sat on "Processing..." forever with no way back.
   */
  modal?: {
    ondismiss?: () => void;
  };
}

interface RazorpayInstance {
  on: (
    event: string,
    handler: (response: RazorpayFailedResponse) => void,
  ) => void;
  open: () => void;
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

/**
 * #1775 P-1 — an order minted elsewhere (an approval or trial pay-link). The
 * component opens it as-is and never calls `POST /api/checkout`.
 */
export interface ExistingRazorpayOrder {
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** #1861 L1 — the pay window's end (ISO); the sheet times out before it. */
  holdExpiresAt?: string | null;
  /** Gateway order state; EXPIRED refuses to open like a lapsed hold. */
  status?: string;
}

type RazorpayCheckoutSource =
  | { checkoutData: CheckoutInput; existingOrder?: never }
  | { existingOrder: ExistingRazorpayOrder; checkoutData?: never };

type RazorpayCheckoutProps = RazorpayCheckoutSource & {
  onPaymentSuccess: (
    response: RazorpayPaymentResponse | { message: string },
  ) => void;
  onPaymentError: (error: RazorpayPaymentError) => void;
  disabled?: boolean;
  userName?: string;
  userEmail?: string;
  userPhone?: string;
  description?: string;
  /**
   * Ran on the click, before anything is charged; returning false aborts.
   *
   * A page gating a finite resource — event seats — can only re-check it here.
   * `disabled` reflects the last render, and a webinar can fill while the tab
   * sits open, so without this the buyer pays into a rejection.
   */
  onBeforeCheckout?: () => Promise<boolean>;
  /** The idle button text; a free order reads "Confirm booking". */
  label?: string;
  /**
   * Set where the page showed the order free: an answer that needs payment
   * comes here instead of opening the sheet, so the buyer sees the price first.
   */
  onPaidWhenFree?: (order: { amount: number; currency: string }) => void;
};

interface GatewayOrder {
  id: string;
  /** The checkout's own Payment row; its hold can be released on dismiss. */
  paymentId?: string;
  amount: number;
  currency: string;
  customerId?: string;
  holdExpiresAt?: string | null;
  /** Mirrors the gateway order state; EXPIRED refuses to open. */
  status?: string;
}

export default function RazorpayCheckout({
  checkoutData,
  existingOrder,
  onPaymentSuccess,
  onPaymentError,
  disabled,
  userName,
  userEmail,
  userPhone,
  description,
  onBeforeCheckout,
  label = "Pay with Razorpay",
  onPaidWhenFree,
}: RazorpayCheckoutProps) {
  const { toast } = useToast();
  const { emiEnabled } = useCheckoutFlags();
  const [isProcessing, setIsProcessing] = useState(false);
  // Synchronous re-entry guard: state updates land a render later than a second click.
  const inFlight = useRef(false);
  const attemptKey = useCheckoutAttemptKey();

  const handleCheckout = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Busy from the click, so a slow pre-check never reads as an ignored press.
    setIsProcessing(true);
    // While the gateway sheet is up it owns the button; only its own exits
    // (dismiss, failure, verified success) may re-enable it.
    let gatewayOpened = false;
    try {
      if (onBeforeCheckout && !(await onBeforeCheckout())) return;
      const order = existingOrder
        ? {
            id: existingOrder.orderId,
            amount: existingOrder.amount,
            currency: existingOrder.currency,
            holdExpiresAt: existingOrder.holdExpiresAt,
            status: existingOrder.status,
          }
        : await createOrder();
      if (!order) return;
      if (onPaidWhenFree) {
        onPaidWhenFree({ amount: order.amount, currency: order.currency });
        return;
      }
      gatewayOpened = await openGateway(order);
    } catch (error) {
      reportPaymentsError(error);
      onPaymentError({
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred",
      });
    } finally {
      if (!gatewayOpened) setIsProcessing(false);
      inFlight.current = false;
    }
  };

  /** Mints the order through checkout; null when it answered without one. */
  const createOrder = async (): Promise<GatewayOrder | null> => {
    // B5 — a structured BUSY 409 (event mutex held / same account on
    // another device) auto-retries ONCE after the server-advised pause
    // instead of dead-ending; the stable idempotency key keeps the retry
    // dedupe-safe.
    if (!checkoutData) return null;
    const response = await fetchCheckoutWithBusyRetry(
      () =>
        fetchWithIdentity("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...checkoutData,
            clientIdempotencyKey: attemptKey(checkoutData),
          }),
        }),
      (waitSeconds, errorType) => toast(busyRetryToast(waitSeconds, errorType)),
    );

    if (!response.ok) {
      const errorData = await response.json();
      onPaymentError({
        description: errorData.error || "Payment request failed",
        // #1583 E-P1-03 — the route's TYPED refusal when it sent one
        // (SLOT_TOO_SOON / SLOT_NOT_ON_GRID), else the coarse errorType. The
        // typed one has to win or the lead-time refusal is titled with the
        // availability bucket, and a buyer who dawdled on the pay page is told
        // the listing went away when only their chosen minute did.
        code: errorData.code || errorData.errorType,
        errorType: errorData.errorType,
      });
      return null;
    }

    const data = await response.json();

    if (!data.success) {
      onPaymentError({
        description: data.error || "Payment initialization failed",
        code: data.code || data.errorType,
        errorType: data.errorType,
      });
      return null;
    }

    // #1437 — WALLET/INVOICE/LICENSE org funding and zero-amount/mock
    // payments confirm synchronously; the response carries no gateway
    // order, so open() must never run for them.
    if (!checkoutNeedsGateway(data)) {
      onPaymentSuccess({
        message:
          data.message ||
          "Your booking is confirmed. Redirecting to your dashboard...",
      });
      return null;
    }

    return {
      id: data.paymentIntent.id,
      paymentId:
        typeof data.paymentId === "string" ? data.paymentId : undefined,
      // A resumed or replayed order carries its amount and currency at the top level.
      amount: data.paymentIntent.amount ?? data.amount,
      currency: data.paymentIntent.currency ?? data.currency,
      // #1771 row 1 — the server echoes a Customer only while saved cards are on.
      customerId: data.paymentIntent.customerId,
      holdExpiresAt: data.holdExpiresAt,
      status: data.paymentIntent.status,
    };
  };

  /** Releases this checkout's hold (payment, seat or time) at the buyer's request. */
  const cancelHeldCheckout = async (paymentId: string) => {
    const couldNotCancel = {
      title: "Couldn't cancel the checkout",
      description:
        "Your hold ends on its own in a few minutes; nothing is charged unless you pay.",
      variant: "destructive" as const,
    };
    try {
      const response = await fetch(
        `/api/checkout/pending/${encodeURIComponent(paymentId)}`,
        { method: "DELETE" },
      );
      toast(
        response.ok
          ? {
              title: "Checkout cancelled",
              description: "Nothing was charged, and the hold is released.",
            }
          : couldNotCancel,
      );
    } catch (error) {
      reportPaymentsError(error);
      toast(couldNotCancel);
    }
  };

  /** Opens the Razorpay sheet on an order; false when it could not open. */
  const openGateway = async (order: GatewayOrder): Promise<boolean> => {
    if (!process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) {
      toast({
        title: "Payment System Configuration Error",
        description:
          "The Razorpay payment system is not properly configured on this website. This is a technical issue on our end. Please contact support for assistance, or try a different payment method.",
        variant: "destructive",
      });
      return false;
    }

    // #1861 L1 — a hold with under two minutes left cannot be paid in time;
    // opening Checkout would only take a payment the hold no longer covers.
    // A stale EXPIRED order refuses the same way.
    if (
      holdTimeoutSeconds(order.holdExpiresAt) === 0 ||
      order.status === "EXPIRED"
    ) {
      toast({
        title: "Your reserved time has run out",
        description:
          "This time is no longer held for you. Please choose the time again to continue.",
        variant: "destructive",
      });
      return false;
    }

    // #1396 — the hold already exists server-side; a CDN failure here is
    // the same state a buyer produces by closing the modal, so leave it
    // to the abandoned-payments sweep instead of cancelling client-side.
    // #1414 — loadScript REJECTS on script.onerror, so `!isLoaded` alone
    // never saw a blocked or failed CDN load; it fell through to the outer
    // catch and the buyer got the generic message instead of this one.
    let isLoaded = false;
    try {
      isLoaded = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      );
    } catch (scriptError) {
      reportPaymentsError(scriptError);
    }

    if (!isLoaded) {
      toast({
        title: "Payment System Not Loading",
        description:
          "The Razorpay payment system couldn't load. This may be due to a slow connection or ad blocker. Please check your internet connection, disable any ad blockers, and try again.",
        variant: "destructive",
      });
      return false;
    }

    const options = buildCheckoutOptions({
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      name: "Familiarise",
      description: description || "Service Payment",
      orderId: order.id,
      customerId: order.customerId,
      // #1780 row 1 — ENABLE_CHECKOUT_EMI off hides Razorpay's EMI block.
      hideEmi: !emiEnabled,
      // #1861 L1 — the sheet closes before the slot hold lapses.
      holdExpiresAt: order.holdExpiresAt,
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
            setIsProcessing(false);
            onPaymentError({
              description:
                "Payment verification failed. Our team will review this transaction.",
              code: "VERIFICATION_FAILED",
            });
            return;
          }
        } catch (verifyErr) {
          // Network failure — don't block; webhook is the ultimate authority
          Sentry.captureException(
            verifyErr instanceof Error
              ? verifyErr
              : new Error(String(verifyErr)),
            { tags: { subsystem: "payments" } },
          );
          console.error("Signature verification request failed:", verifyErr);
        }
        onPaymentSuccess(response);
      },
      prefill:
        userName || userEmail || userPhone
          ? {
              ...(userName && { name: userName }),
              ...(userEmail && { email: userEmail }),
              ...(userPhone && { contact: userPhone }),
            }
          : undefined,
      theme: {
        color: "#2563EB", // Familiarise brand blue
      },
      onDismiss: () => {
        setIsProcessing(false);
        const { paymentId } = order;
        toast({
          title: "Payment not completed",
          description:
            "You closed the payment window before finishing. Your booking is still held — you can retry whenever you're ready.",
          // Releasing the hold frees the time or seat for someone else now.
          ...(paymentId
            ? {
                action: (
                  <ToastAction
                    altText="Cancel this checkout and release the hold"
                    onClick={() => void cancelHeldCheckout(paymentId)}
                  >
                    Cancel checkout
                  </ToastAction>
                ),
              }
            : {}),
        });
      },
    });

    const rzp = new window.Razorpay(options);
    rzp.on("payment.failed", function (response: RazorpayFailedResponse) {
      setIsProcessing(false);
      onPaymentError(response.error);
    });
    rzp.open();
    return true;
  };

  return (
    <Button onClick={handleCheckout} disabled={isProcessing || disabled}>
      {isProcessing ? "Processing..." : label}
    </Button>
  );
}
