"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckoutResultSkeleton } from "@/app/checkout/CheckoutSkeletons";
import { CheckCircle, Clock, Calendar, ArrowRight } from "lucide-react";
import { reportPaymentsError } from "@/app/checkout/plans/utils";
import type { BookingState } from "@/app/api/checkout/verify/route";
interface PaymentDetails {
  paymentIntent: string;
  appointmentType: string;
  status: string;
  message: string;
  /** #1586 — absent while the pipeline has not landed; the page keeps polling. */
  bookingState?: BookingState;
}

/**
 * What the verify poll settled on. `confirming` is the normal terminal state
 * on a slow capture: the money may be captured while the pipeline has not
 * finished, and saying "failed" there sends a charged buyer to support. Only
 * an explicit FAILED/EXPIRED answer earns the failure card (#1591 J1-P1-02).
 */
type VerifyPhase = "loading" | "confirmed" | "confirming" | "failed";

// #1591 J1-P1-02 — six 1.5 s tries was nine seconds, and a cold instance can
// spend longer than that on the pipeline; back off to roughly a minute. The
// retry button restarts a short poll.
const RETRY_DELAYS_MS = [
  1500, 1500, 3000, 3000, 5000, 5000, 10000, 10000, 20000,
];
const RETRY_NOW_DELAYS_MS = [2000, 2000, 3000];
const FAILED_PAYMENT_STATUSES = new Set(["FAILED", "EXPIRED"]);

function CheckoutSuccessContent() {
  const [paymentDetails, setPaymentDetails] = useState<PaymentDetails | null>(
    null,
  );
  const [phase, setPhase] = useState<VerifyPhase>("loading");
  const [pollRun, setPollRun] = useState(0);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Support both Stripe Checkout (sends session_id) and direct PI flow (sends payment_intent)
  const paymentIntent =
    searchParams.get("session_id") || searchParams.get("payment_intent");

  useEffect(() => {
    let cancelled = false;

    async function verifyPayment() {
      if (!paymentIntent) {
        console.error("Invalid payment session");
        router.push("/dashboard");
        return;
      }

      // Booking confirmation is webhook-driven, so at the moment the buyer
      // lands here the money may well have been captured while the pipeline
      // (appointment, earnings, journal) has not finished. This page used to
      // treat that as a FAILURE and bounce to /checkout-failure — telling
      // someone their payment failed while their card was in fact charged.
      //
      // `sync=true` asks the server to drive the canonical pipeline itself
      // (safe since ADR 21 — it runs the same idempotent handler the webhook
      // runs), and a bounded poll covers the case where the webhook wins the
      // race a moment later. Only after the poll is exhausted do we say
      // anything, and then it is "still confirming", never "failed".
      const delays = pollRun === 0 ? RETRY_DELAYS_MS : RETRY_NOW_DELAYS_MS;
      const maxAttempts = delays.length + 1;
      setPhase("loading");

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (cancelled) return;
        let waitMs = delays[attempt] ?? 0;
        try {
          const response = await fetch(
            `/api/checkout/verify?payment_intent=${encodeURIComponent(paymentIntent)}&sync=true`,
          );
          const data = await response.json();
          if (response.status === 429 || response.status === 503) {
            // Honour the verify route's own pause (#1591 J1-P1-02). A 503 is
            // the force-fresh session lookup's replica-lag retry (it carries
            // Retry-After, qa-1752), never a verdict on the payment.
            const retryAfter = Number(
              data?.retryAfter ?? response.headers.get("Retry-After"),
            );
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              waitMs = Math.min(retryAfter * 1000, 30000);
            }
            if (attempt < maxAttempts - 1) {
              await new Promise((r) => setTimeout(r, waitMs));
            }
            continue;
          }

          if (response.ok) {
            if (cancelled) return;
            setPaymentDetails(data);
            // #1586 P1-J07 — SUCCEEDED alone is not "confirmed" (the #827
            // loser and the amount-mismatch case are SUCCEEDED with no
            // booking). Stop polling only once the route names the state.
            if (data.bookingState) {
              setPhase("confirmed");
              return;
            }
            setPhase("confirming");
          } else if (
            response.status === 500 &&
            data?.errorType === "VERIFICATION_FAILED"
          ) {
            // #1586 P1-J32 — the route itself failed, not the payment; a
            // charged buyer must not be told the payment failed. Keep polling.
            console.error(data.error ?? "Payment verification failed");
          } else if (response.status === 400) {
            // 400 is "payment not completed": PENDING keeps waiting, while an
            // explicit FAILED/EXPIRED is the one answer that earns "failed".
            if (FAILED_PAYMENT_STATUSES.has(String(data?.status))) {
              if (cancelled) return;
              setPhase("failed");
              return;
            }
          } else {
            // Anything else is a real verification error.
            console.error(data.message || "Payment verification failed");
            router.push("/checkout/checkout-failure");
            return;
          }
        } catch (error) {
          reportPaymentsError(error);
          console.error("Payment verification error:", error);
        }

        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      // Poll exhausted. The money is captured or still settling; the booking
      // just has not materialised yet. The stuck-webhook sweeper and
      // reconcile-orphaned-confirmations both re-drive it, so the page keeps
      // showing "confirming" — never "failed".
      if (cancelled) return;
      setPhase("confirming");
    }

    verifyPayment();
    return () => {
      cancelled = true;
    };
  }, [paymentIntent, router, pollRun]);

  const pendingIcon = <Clock className="h-6 w-6 text-yellow-500" />;
  const confirmedIcon = <CheckCircle className="h-6 w-6 text-green-500" />;

  // #1586 P1-J07/J08 — headline and status follow the booking state the
  // verify route derived, never the appointment type alone.
  const getBookingStateMessage = (state: BookingState | undefined) => {
    switch (state) {
      case "PENDING_APPROVAL":
        return {
          title: "Request sent — awaiting consultant approval",
          description:
            "Your payment has been processed successfully. Your request is now with the consultant.",
          nextSteps:
            "You'll receive an email notification once the consultant approves your booking.",
          statusIcon: pendingIcon,
          statusText: "Pending Consultant Approval",
        };
      case "AWAITING_ALLOCATION":
        return {
          title: "Paid — your sessions will be scheduled",
          description:
            "Your payment has been processed successfully. Your sessions have not been placed on the calendar yet.",
          nextSteps:
            "You'll receive an email as each session is scheduled; you can follow along from your dashboard.",
          statusIcon: pendingIcon,
          statusText: "Awaiting scheduling",
        };
      case "REFUND_PENDING":
        return {
          title: "Payment received but the slot was taken — refund on its way",
          description:
            "Someone else confirmed this time first, so your booking could not be placed. Your payment is being refunded in full.",
          nextSteps:
            "The refund lands on the original payment method; you'll get an email when it does. Pick another time whenever you're ready.",
          statusIcon: pendingIcon,
          statusText: "Refund pending",
        };
      case "REFUNDED":
        return {
          title: "Payment received but the slot was taken — refunded in full",
          description:
            "Someone else confirmed this time first, so your booking could not be placed. Your payment has already been returned.",
          nextSteps:
            "Wallet and credit refunds are back already; a card refund shows on your statement within a few days. Pick another time whenever you're ready.",
          statusIcon: pendingIcon,
          statusText: "Refunded",
        };
      default:
        return null;
    }
  };

  const getStatusMessage = (appointmentType: string) => {
    switch (appointmentType) {
      case "CONSULTATION":
        return {
          title: "Consultation Booking Confirmed!",
          description:
            "Your payment has been processed successfully and your consultation is confirmed.",
          nextSteps:
            "You'll receive a confirmation email with the session details and join link.",
          statusIcon: confirmedIcon,
          statusText: "Confirmed",
        };
      case "SUBSCRIPTION":
        return {
          title: "Subscription Activated!",
          description:
            "Your payment has been processed successfully and your subscription is active.",
          nextSteps:
            "You'll receive a confirmation email with your session schedule.",
          statusIcon: confirmedIcon,
          statusText: "Confirmed",
        };
      case "WEBINAR":
        return {
          title: "Webinar Registration Complete!",
          description:
            "Your payment has been processed successfully. You're now registered for the webinar.",
          nextSteps:
            "You'll receive a confirmation email with the webinar join link and details.",
          statusIcon: confirmedIcon,
          statusText: "Confirmed",
        };
      case "CLASS":
        return {
          title: "Class Enrollment Complete!",
          description:
            "Your payment has been processed successfully. You're now enrolled in the class.",
          nextSteps:
            "You'll receive a confirmation email with class details and access information.",
          statusIcon: confirmedIcon,
          statusText: "Confirmed",
        };
      default:
        // Reached when the payment is settled but no appointment is linked
        // yet. Saying "Confirmed" here would be a lie the buyer acts on — they
        // would close the tab and expect a session that does not exist. Say
        // what is actually true: we have the money, the booking is landing.
        return {
          title: "Payment received",
          description:
            "We have your payment. Your booking is being confirmed — this usually takes a few seconds.",
          nextSteps:
            "You'll get a confirmation email as soon as it's done. If you don't see it within a few minutes, contact support with your payment reference and we'll finish it manually — your payment is safe either way.",
          statusIcon: pendingIcon,
          statusText: "Confirming your booking",
        };
    }
  };

  if (phase === "loading") {
    return <CheckoutResultSkeleton />;
  }

  if (phase === "failed") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted px-4">
        <Card className="w-full max-w-md border-border shadow-lg">
          <CardContent className="pt-6">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-foreground mb-2">
                Payment Verification Failed
              </h2>
              <p className="text-muted-foreground mb-4">
                We couldn&apos;t verify your payment. Please contact support.
              </p>
              <Button onClick={() => router.push("/dashboard")}>
                Go to Dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!paymentDetails) {
    // The poll ran out while the payment was still PENDING. Nothing has gone
    // wrong: the bank confirms, the webhook lands, the receipt is emailed.
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted px-4">
        <Card className="w-full max-w-md border-border shadow-lg">
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
                <Clock className="h-7 w-7 text-amber-600" />
              </div>
              <h2
                className="text-lg font-semibold text-foreground mb-2"
                data-testid="checkout-still-confirming"
              >
                Still confirming your payment
              </h2>
              <p className="text-muted-foreground mb-4">
                We&apos;ll email you the receipt as soon as the bank confirms.
                There&apos;s nothing more you need to do.
              </p>
              {paymentIntent && (
                <p className="text-xs text-muted-foreground/70 font-mono break-all mb-4">
                  Payment ID: {paymentIntent}
                </p>
              )}
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button
                  variant="outline"
                  onClick={() => setPollRun((run) => run + 1)}
                >
                  Retry now
                </Button>
                <Button onClick={() => router.push("/dashboard")}>
                  Go to Dashboard
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statusInfo =
    getBookingStateMessage(paymentDetails.bookingState) ??
    getStatusMessage(
      paymentDetails.bookingState === "CONFIRMED"
        ? paymentDetails.appointmentType
        : "UNKNOWN",
    );

  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          {paymentDetails.bookingState === "CONFIRMED" ? (
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
              <CheckCircle className="h-10 w-10 text-emerald-600" />
            </div>
          ) : (
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock className="h-10 w-10 text-amber-600" />
            </div>
          )}
          <h1 className="text-fluid-3xl font-bold tracking-tight text-foreground">
            {statusInfo.title}
          </h1>
        </div>

        <Card className="mb-6 border-border shadow-lg">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              Booking Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Status:</span>
              <div className="flex items-center gap-2 min-w-0">
                {statusInfo.statusIcon}
                <span className="font-medium text-foreground">
                  {statusInfo.statusText}
                </span>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-muted-foreground mb-3">
                {statusInfo.description}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {statusInfo.nextSteps}
              </p>
            </div>

            {paymentIntent && (
              <div className="border-t border-border pt-4">
                <div className="text-sm text-muted-foreground/70 font-mono break-all">
                  Payment ID: {paymentIntent}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button variant="outline" onClick={() => router.push("/dashboard")}>
            Go to Dashboard
          </Button>

          <Button
            onClick={() => router.push("/dashboard")}
            className="flex items-center justify-center gap-2"
          >
            View Appointments
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <p>
            Need help? Contact our{" "}
            <a
              href="/dashboard"
              className="text-foreground font-medium hover:underline"
            >
              support team
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<CheckoutResultSkeleton />}>
      <CheckoutSuccessContent />
    </Suspense>
  );
}
