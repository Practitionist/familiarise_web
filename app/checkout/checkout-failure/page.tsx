"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { XCircle, RefreshCw, ArrowLeft, MessageCircle } from "lucide-react";

export default function CheckoutFailurePage() {
  const [error, setError] = useState<string>("");
  const searchParams = useSearchParams();
  const router = useRouter();

  const paymentIntent = searchParams.get("payment_intent");
  const errorMessage = searchParams.get("error");

  useEffect(() => {
    // Set error message from URL params or default
    setError(errorMessage || "Payment failed. Please try again.");
  }, [errorMessage]);

  const handleRetryPayment = () => {
    // Go back to the previous page to retry
    router.back();
  };

  const handleContactSupport = () => {
    // Navigate to support page with payment intent info
    const supportUrl = `/support?issue=payment_failed${paymentIntent ? `&payment_intent=${paymentIntent}` : ""}`;
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
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <XCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Payment Failed
          </h1>
          <p className="text-gray-600">
            We couldn't process your payment. Don't worry, no charges were made.
          </p>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-red-600">Error Details</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700 mb-4">{error}</p>
            {paymentIntent && (
              <div className="text-sm text-gray-500 border-t pt-4">
                Payment Intent ID: {paymentIntent}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Common Reasons for Payment Failure</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {commonFailureReasons.map((reason, index) => (
                <div key={index} className="border-l-4 border-gray-200 pl-4">
                  <h4 className="font-medium text-gray-900">{reason.title}</h4>
                  <p className="text-sm text-gray-600">{reason.description}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            onClick={handleRetryPayment}
            className="flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>

          <Button
            variant="outline"
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Go to Dashboard
          </Button>

          <Button
            variant="outline"
            onClick={handleContactSupport}
            className="flex items-center gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            Contact Support
          </Button>
        </div>

        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-medium text-blue-900 mb-2">What happens next?</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• No charges were made to your payment method</li>
            <li>• Your booking slot is still available for a limited time</li>
            <li>• You can retry with the same or different payment method</li>
            <li>• Contact support if you continue to experience issues</li>
          </ul>
        </div>

        <div className="mt-6 text-center text-sm text-gray-500">
          <p>
            Need immediate assistance?{" "}
            <a href="/support" className="text-blue-600 hover:underline">
              Contact our support team
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
