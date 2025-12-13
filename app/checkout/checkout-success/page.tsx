"use client";

import { useEffect, useState } from "react";
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

export default function CheckoutSuccessPage() {
  const [paymentDetails, setPaymentDetails] = useState<PaymentDetails | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const searchParams = useSearchParams();
  const router = useRouter();

  const paymentIntent = searchParams.get("payment_intent");
  const paymentIntentClientSecret = searchParams.get(
    "payment_intent_client_secret",
  );

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
          `/api/checkout/verify?payment_intent=${paymentIntent}`,
        );
        const data = await response.json();

        if (response.ok) {
          setPaymentDetails(data);
        } else {
          console.error(data.message || "Payment verification failed");
          router.push("/checkout/checkout-failure");
        }
      } catch (error) {
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
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900"></div>
      </div>
    );
  }

  if (!paymentDetails) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Card className="w-full max-w-md border-zinc-200 shadow-lg">
          <CardContent className="pt-6">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-zinc-900 mb-2">
                Payment Verification Failed
              </h2>
              <p className="text-zinc-600 mb-4">
                We couldn&apos;t verify your payment. Please contact support.
              </p>
              <Button 
                onClick={() => router.push("/dashboard")}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
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
    <div className="min-h-screen bg-zinc-50 py-12">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle className="h-10 w-10 text-emerald-600" />
          </div>
          <h1 className="text-3xl font-bold text-zinc-900">
            {statusInfo.title}
          </h1>
        </div>

        <Card className="mb-6 border-zinc-200 shadow-lg">
          <CardHeader className="border-b border-zinc-100">
            <CardTitle className="flex items-center gap-2 text-zinc-900">
              <Calendar className="h-5 w-5 text-zinc-600" />
              Booking Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-zinc-600">Status:</span>
              <div className="flex items-center gap-2">
                {statusInfo.statusIcon}
                <span className="font-medium text-zinc-900">{statusInfo.statusText}</span>
              </div>
            </div>

            <div className="border-t border-zinc-100 pt-4">
              <p className="text-zinc-700 mb-3">{statusInfo.description}</p>
              <p className="text-sm text-zinc-500">{statusInfo.nextSteps}</p>
            </div>

            {paymentIntent && (
              <div className="border-t border-zinc-100 pt-4">
                <div className="text-sm text-zinc-500 font-mono">
                  Payment ID: {paymentIntent}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex gap-4 justify-center">
          <Button 
            variant="outline" 
            onClick={() => router.push("/dashboard")}
            className="border-zinc-300 text-zinc-700 hover:bg-zinc-100"
          >
            Go to Dashboard
          </Button>

          <Button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 text-white"
          >
            View Appointments
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-8 text-center text-sm text-zinc-500">
          <p>
            Need help? Contact our{" "}
            <a href="/support" className="text-zinc-900 font-medium hover:underline">
              support team
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
