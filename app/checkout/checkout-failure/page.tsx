"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckoutResultSkeleton } from "@/app/checkout/CheckoutSkeletons";
import { XCircle, RefreshCw, ArrowLeft, MessageCircle } from "lucide-react";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import { getStaticErrorDescription } from "@/lib/errors/mapping/payment-error-toast-map";

// Only app-chosen copy renders: a known `code` shows its fixed text, anything else the generic line.
const failureCodeSchema = z.nativeEnum(ErrorTypes);
// A payment reference is an id, never a sentence: letters, digits and underscores only.
const paymentReferenceSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const GENERIC_FAILURE_MESSAGE = "Payment failed. Please try again.";

function CheckoutFailureContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const parsedReference = paymentReferenceSchema.safeParse(
    searchParams.get("payment_intent"),
  );
  const paymentIntent = parsedReference.success ? parsedReference.data : null;
  const failureCode = failureCodeSchema.safeParse(searchParams.get("code"));
  const error =
    (failureCode.success
      ? getStaticErrorDescription(failureCode.data)
      : null) ?? GENERIC_FAILURE_MESSAGE;

  const handleRetryPayment = () => {
    // Go back to the previous page to retry
    router.back();
  };

  const handleContactSupport = () => {
    // E2E-audit fix — /support does not exist as a public route; the support
    // hub lives inside the dashboard. Carry the failure context in the query
    // so the dashboard landing can route it onward.
    const supportUrl = `/dashboard?issue=payment_failed${paymentIntent ? `&payment_intent=${encodeURIComponent(paymentIntent)}` : ""}`;
    router.push(supportUrl);
  };

  const commonFailureReasons = [
    {
      title: "Card Declined",
      description:
        "Your bank declined the payment. Contact your bank or try a different card.",
    },
    {
      title: "Insufficient Funds",
      description:
        "There may not be enough balance in your account. Check your account balance.",
    },
    {
      title: "Technical Issue",
      description:
        "A temporary technical issue occurred. Please try again in a few minutes.",
    },
    {
      title: "Authentication Failed",
      description:
        "Card authentication failed. Make sure all details are correct and try again.",
    },
  ];

  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
            <XCircle className="h-10 w-10 text-red-600" />
          </div>
          <h1 className="text-fluid-3xl font-bold tracking-tight text-foreground mb-2">
            Payment Failed
          </h1>
          <p className="text-muted-foreground">
            We couldn&apos;t confirm your payment. If any amount was deducted,
            it will be refunded automatically or shown as confirmed in{" "}
            <Link
              href="/dashboard/go/auto/payments"
              className="text-foreground font-medium underline"
            >
              Billing
            </Link>
            .
          </p>
        </div>

        <Card className="mb-6 border-border shadow-lg">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-red-600">Error Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <p className="text-muted-foreground mb-4">{error}</p>
            {paymentIntent && (
              <div className="text-sm text-muted-foreground/70 border-t border-border pt-4 font-mono break-all">
                Payment Intent ID: {paymentIntent}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6 border-border shadow-lg">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-foreground">
              Common Reasons for Payment Failure
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-4">
              {commonFailureReasons.map((reason, index) => (
                <div key={index} className="border-l-4 border-border pl-4">
                  <h4 className="font-medium text-foreground">
                    {reason.title}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {reason.description}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            onClick={handleRetryPayment}
            className="flex items-center justify-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>

          <Button
            variant="outline"
            onClick={() => router.push("/dashboard")}
            className="flex items-center justify-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Go to Dashboard
          </Button>

          <Button
            variant="outline"
            onClick={handleContactSupport}
            className="flex items-center justify-center gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            Contact Support
          </Button>
        </div>

        <div className="mt-8 bg-foreground border border-border rounded-xl p-5">
          <h3 className="font-medium text-background mb-3">
            What happens next?
          </h3>
          <ul className="text-sm text-background/70 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              <span>
                Check{" "}
                <Link
                  href="/dashboard/go/auto/payments"
                  className="text-background underline"
                >
                  Billing
                </Link>{" "}
                before paying again, so you are not charged twice
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              Your slot is held only while your payment window is open. Once it
              ends without a payment, the slot is released and someone else can
              book it
            </li>
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              You can retry with the same or different payment method
            </li>
            <li className="flex items-start gap-2">
              <span className="text-background/50">•</span>
              Contact support if you continue to experience issues
            </li>
          </ul>
        </div>

        <div className="mt-6 text-center text-sm text-muted-foreground">
          <p>
            Need immediate assistance?{" "}
            <Link
              href="/dashboard"
              className="text-foreground font-medium hover:underline"
            >
              Contact our support team
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutFailurePage() {
  return (
    <Suspense fallback={<CheckoutResultSkeleton />}>
      <CheckoutFailureContent />
    </Suspense>
  );
}
