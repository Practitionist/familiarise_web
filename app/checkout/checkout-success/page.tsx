"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, Calendar, ArrowRight } from "lucide-react";
interface PaymentDetails {
  paymentIntent: string;
  appointmentType: string;
  status: string;
  message: string;
}

function CheckoutSuccessContent() {
  const [paymentDetails, setPaymentDetails] = useState<PaymentDetails | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Support both Stripe Checkout (sends session_id) and direct PI flow (sends payment_intent)
  const paymentIntent =
    searchParams.get("session_id") || searchParams.get("payment_intent");

  useEffect(() => {
    async function verifyPayment() {
      if (!paymentIntent) {
        console.error("Invalid payment session");
        router.push("/dashboard");
        return;
      }

      try {
        // Verify payment status and get appointment details
        const response = await fetch(
          `/api/checkout/verify?payment_intent=${encodeURIComponent(paymentIntent)}`,
        );
        const data = await response.json();

        if (response.ok) {
          setPaymentDetails(data);
        } else {
          console.error(data.message || "Payment verification failed");
          router.push("/checkout/checkout-failure");
        }
      } catch (error) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "payments" } });
        console.error("Payment verification error:", error);
        router.push("/checkout/checkout-failure");
      } finally {
        setLoading(false);
      }
    }

    verifyPayment();
  }, [paymentIntent, router]);

  const getStatusMessage = (appointmentType: string) => {
    switch (appointmentType) {
      case "CONSULTATION":
        return {
          title: "Consultation Booking Confirmed!",
          description:
            "Your payment has been processed successfully. Your consultation request is now pending approval from the consultant.",
          nextSteps:
            "You'll receive an email notification once the consultant approves your booking.",
          statusIcon: <Clock className="h-6 w-6 text-yellow-500" />,
          statusText: "Pending Consultant Approval",
        };
      case "SUBSCRIPTION":
        return {
          title: "Subscription Activated!",
          description:
            "Your payment has been processed successfully. Your subscription request is now pending approval from the consultant.",
          nextSteps:
            "You'll receive an email notification once the consultant activates your subscription.",
          statusIcon: <Clock className="h-6 w-6 text-yellow-500" />,
          statusText: "Pending Consultant Approval",
        };
      case "WEBINAR":
        return {
          title: "Webinar Registration Complete!",
          description:
            "Your payment has been processed successfully. You're now registered for the webinar.",
          nextSteps:
            "You'll receive a confirmation email with the webinar join link and details.",
          statusIcon: <CheckCircle className="h-6 w-6 text-green-500" />,
          statusText: "Confirmed",
        };
      case "CLASS":
        return {
          title: "Class Enrollment Complete!",
          description:
            "Your payment has been processed successfully. You're now enrolled in the class.",
          nextSteps:
            "You'll receive a confirmation email with class details and access information.",
          statusIcon: <CheckCircle className="h-6 w-6 text-green-500" />,
          statusText: "Confirmed",
        };
      default:
        return {
          title: "Payment Successful!",
          description: "Your payment has been processed successfully.",
          nextSteps: "You'll receive a confirmation email shortly.",
          statusIcon: <CheckCircle className="h-6 w-6 text-green-500" />,
          statusText: "Confirmed",
        };
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground"></div>
      </div>
    );
  }

  if (!paymentDetails) {
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

  const statusInfo = getStatusMessage(paymentDetails.appointmentType);

  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle className="h-10 w-10 text-emerald-600" />
          </div>
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
              href="/support"
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
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground"></div>
        </div>
      }
    >
      <CheckoutSuccessContent />
    </Suspense>
  );
}
