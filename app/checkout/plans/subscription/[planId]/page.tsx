"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fetchReviews } from "@/lib/user";
import {
  ConsultantProfile,
  ConsultantReview,
  SubscriptionPlan,
} from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useEffect, useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { loadStripe } from "@stripe/stripe-js";

type SubscriptionPlanWithConsultant = SubscriptionPlan & {
  consultantProfile: ConsultantProfile & {
    user: {
      id: string;
      name: string;
      email: string;
      image: string;
    };
  };
};

type SubscriptionResponse = {
  data: SubscriptionPlanWithConsultant;
};

const subscriptionSchema = z.object({
  discountCode: z.string().optional(),
});

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function SubscriptionCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const [planData, setPlanData] = useState<SubscriptionResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ConsultantReview[]>([]);
  const { toast } = useToast();

  // Common error handling logic
  const handleApiError = (errorData: any) => {
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

  // Common API request logic
  const makeCheckoutRequest = async (parsedParams: any, gateway: string) => {
    return fetch("/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appointmentType: "SUBSCRIPTION",
        planId: resolvedParams.planId,
        // TODO: Add proper slot selection UI for subscriptions
        // For now, use placeholder times that will be scheduled later
        slotStartTimeInUTC: new Date(
          Date.now() + 24 * 60 * 60 * 1000,
        ).toISOString(), // Tomorrow
        slotEndTimeInUTC: new Date(
          Date.now() + 25 * 60 * 60 * 1000,
        ).toISOString(), // Tomorrow + 1 hour
        discountCode: parsedParams.data.discountCode,
        paymentGateway: gateway,
      }),
    });
  };

  // Common success handling logic
  const handleCheckoutSuccess = (data: any, isDevMode: boolean = false) => {
    if (isDevMode) {
      // Development mode - direct subscription success
      toast({
        title: "✅ Subscription Activated Successfully!",
        description: data.skipPayment
          ? "Your subscription is now active. Check your dashboard for details."
          : "Payment processed successfully. Your subscription is now active.",
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
        description:
          "Redirecting to secure payment gateway. Complete your payment to activate the subscription.",
        variant: "default",
      });
    }
  };

  // Development workflow - direct subscription
  const handleDevCheckout = async (parsedParams: any, gateway: string) => {
    const response = await makeCheckoutRequest(parsedParams, gateway);

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(errorData);
      throw new Error(errorData.error || "Subscription failed");
    }

    const data = await response.json();
    handleCheckoutSuccess(data, true);
  };

  // Production workflow - payment gateway processing
  const handleProdCheckout = async (
    parsedParams: any,
    gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW",
  ) => {
    const response = await makeCheckoutRequest(parsedParams, gateway);

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(errorData);
      throw new Error(errorData.error || "Checkout failed");
    }

    const data = await response.json();

    // Show success toast before redirecting
    handleCheckoutSuccess(data, false);

    // Small delay to let user see the toast before redirect
    setTimeout(async () => {
      // Handle gateway-specific responses
      switch (gateway) {
        case "STRIPE":
          const stripe = await loadStripe(process.env.NEXT_PUBLIC_STRIPE_KEY!);
          await stripe?.confirmPayment({
            clientSecret: data.clientSecret,
            confirmParams: {
              return_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success`,
            },
          });
          break;

        case "RAZORPAY":
          window.location.href = `/checkout/razorpay?order_id=${data.orderId}`;
          break;

        case "LEMON_SQUEEZY":
        case "XFLOW":
          window.location.href = data.checkoutUrl;
          break;
      }
    }, 1000);
  };

  const handleCheckout = useCallback(
    async (gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW") => {
      try {
        // Validate params first
        const parsedParams = subscriptionSchema.safeParse(resolvedSearchParams);
        if (!parsedParams.success) {
          throw new Error("Invalid subscription parameters");
        }

        // Route to appropriate workflow based on environment
        const isDevelopment =
          process.env.NODE_ENV === "development" ||
          process.env.NODE_ENV === "test";

        if (isDevelopment) {
          await handleDevCheckout(parsedParams, gateway);
        } else {
          await handleProdCheckout(parsedParams, gateway);
        }
      } catch (error) {
        console.error("Checkout error:", error);

        // Only show generic error if it wasn't already handled
        if (!(error instanceof Error && error.message.includes("failed"))) {
          toast({
            title: "Checkout Failed",
            description:
              error instanceof Error ? error.message : "Please try again",
            variant: "destructive",
          });
        }
      }
    },
    [resolvedParams, resolvedSearchParams, toast],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/plans/subscriptions/${resolvedParams.planId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(data.data.consultantProfile.id);
        setReviews(reviewsData);
      } catch (error) {
        console.error("Error fetching plan data:", error);
        setError(
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchPlanData();
  }, [resolvedParams.planId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div
          className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 max-w-lg mx-auto text-center"
          role="alert"
        >
          <p className="font-bold">Oops! Something went wrong</p>
          <p>{error}</p>
          <p className="mt-2">
            Please check your selection and try again. If the problem persists,
            contact support.
          </p>
        </div>
      </div>
    );
  }

  const consultantDetails = planData?.data.consultantProfile;
  const userDetails = planData?.data.consultantProfile.user;

  return (
    <>
      <div className="flex flex-col gap-8 border-r bg-muted/40 p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Avatar className="w-12 h-12 border">
              <AvatarImage
                src={userDetails?.image || "/placeholder-user.jpg"}
                alt={userDetails?.name || "Consultant"}
              />
              <AvatarFallback>
                {userDetails?.name ? userDetails.name.charAt(0) : "C"}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">
                {userDetails?.name || "Consultant Name"}
              </div>
              <div className="text-sm text-muted-foreground">
                {consultantDetails?.specialization || "Consultant"}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold">Subscription</div>
            <div className="text-sm text-muted-foreground">
              {planData?.data?.title || "Monthly Plan"}
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Subscription Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{planData?.data?.durationInMonths || 1} months</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Calls per Week</div>
              <div>{planData?.data?.callsPerWeek || 1} calls</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Video Meetings</div>
              <div>{planData?.data?.videoMeetings || 1} per month</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Email Support</div>
              <div>{planData?.data?.emailSupport || "General"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planData?.data?.language || "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planData?.data?.level || "Beginner"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{planData?.data?.prerequisites || "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{planData?.data?.materialProvided || "None"}</div>
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-4">
          <div className="font-semibold">Discount Codes</div>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="Enter discount code"
              className="flex-1"
            />
            <Button variant="outline">Apply</Button>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">SUB20</div>
                <div className="text-sm text-muted-foreground">
                  Get 20% off your subscription
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">20% off</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Subscription Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Monthly Fee</div>
                <div>${planData?.data?.price || 100}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>{planData?.data?.callsPerWeek || 1} calls per week</li>
                    <li>{planData?.data?.videoMeetings || 1} video meetings</li>
                    <li>
                      {planData?.data?.emailSupport || "General"} email support
                    </li>
                    <li>Learning materials</li>
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>${planData?.data?.price || 100}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax (10%)</div>
                <div>${((planData?.data?.price || 100) * 0.1).toFixed(2)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Discount (20%)</div>
                <div>
                  -$
                  {((planData?.data?.price || 100) * 0.2).toFixed(2)}
                </div>
              </div>
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Net Amount</div>
                <div>${((planData?.data?.price || 100) * 0.9).toFixed(2)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="font-semibold">Payment</div>
            <div className="text-muted-foreground">
              Select your preferred payment method
            </div>
          </div>
          {/* Payment Gateway Cards */}
          {[
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
          ].map((gateway) => (
            <Card key={gateway.name}>
              <CardHeader>
                <CardTitle>{gateway.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <CreditCardIcon className="w-8 h-8" />
                    <div>
                      <div className="font-semibold">Credit/Debit Card</div>
                      <div className="text-sm text-muted-foreground">
                        {gateway.description}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => handleCheckout(gateway.gateway)}
                  >
                    Pay with {gateway.name}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
