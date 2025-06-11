"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fetchReviews } from "@/lib/user";
import type { ConsultantReview } from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useEffect, useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  CheckoutInput,
  checkoutResponseSchema,
  classSearchParamsSchema,
  createCheckoutData
} from "@/schemas/checkout";
import {
  PaymentGateway,
} from "@prisma/client";
import { loadStripe } from "@stripe/stripe-js";
import RazorpayCheckout from "../../../components/RazorpayCheckout";

import type { TClass } from "@/types/appointment";

type ClassResponse = {
  data: TClass;
};

type PageProps = {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ClassCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const [planData, setPlanData] = useState<ClassResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, _setReviews] = useState<ConsultantReview[]>([]);
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );
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
        title: "Registration Unavailable",
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
  const makeCheckoutRequest = async (checkoutData: CheckoutInput) => {
    return fetch("/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(checkoutData),
    });
  };

  // Common success handling logic
  const handleCheckoutSuccess = (data: any, isDevMode: boolean = false) => {
    if (isDevMode) {
      // Development mode - direct registration success
      toast({
        title: "✅ Class Registration Successful!",
        description: data.skipPayment
          ? "You're registered for the class. Check your dashboard for details."
          : "Payment processed successfully. You're registered for the class.",
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
          "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        variant: "default",
      });
    }
  };

  // Production workflow - payment gateway processing
  const handleProdCheckout = async (
    checkoutData: CheckoutInput,
    gateway: PaymentGateway,
  ) => {
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
  };

  const handleCheckout = useCallback(
    async (gateway: PaymentGateway) => {
      // Prevent double-clicks and multiple simultaneous requests
      if (isCheckoutProcessing) {
        return;
      }

      try {
        // Set loading state
        setIsCheckoutProcessing(true);
        setProcessingGateway(gateway);

        // Validate search params using the shared schema
        const searchParamsValidation = classSearchParamsSchema.safeParse(resolvedSearchParams);
        if (!searchParamsValidation.success) {
          throw new Error("Invalid class parameters");
        }

        if (!planData?.data?.classPlan?.id) {
          throw new Error("Class plan not found");
        }

        // Create checkout data using the shared utility
        const checkoutData = createCheckoutData({
          appointmentType: "CLASS",
          planId: planData.data.classPlan.id,
          eventId: resolvedParams.classId,
          discountCode: searchParamsValidation.data.discountCode,
          paymentGateway: gateway,
        });

        // Handle production checkout flow
        await handleProdCheckout(checkoutData, gateway);
      } catch (error) {
        console.error("Checkout error:", error);
        if (error instanceof Error) {
          toast({
            title: "Checkout Failed",
            description: error.message,
            variant: "destructive",
          });
        }
      } finally {
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [
      isCheckoutProcessing,
      resolvedSearchParams,
      planData?.data?.classPlan?.id,
      resolvedParams.classId,
      toast,
    ],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/events/classes/${resolvedParams.classId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.classPlan?.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(
          data.data.classPlan.consultantProfile?.id ?? "",
        );
        _setReviews(reviewsData);
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
  }, [resolvedParams.classId]);

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

  const consultantDetails = planData?.data?.classPlan?.consultantProfile;
  const userDetails = planData?.data?.classPlan?.consultantProfile?.user;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[60%_40%] min-h-screen">
      <div className="flex flex-col gap-8 border-r bg-muted/40 p-8 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Avatar className="w-12 h-12 border">
              <AvatarImage
                src={userDetails?.image ?? "/placeholder-user.jpg"}
                alt={userDetails?.name ?? "Consultant"}
              />
              <AvatarFallback>
                {userDetails?.name ? userDetails.name.charAt(0) : "C"}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">
                {userDetails?.name ?? "Consultant Name"}
              </div>
              <div className="text-sm text-muted-foreground">
                {consultantDetails?.specialization ?? "Consultant"}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold">Class</div>
            <div className="text-sm text-muted-foreground">
              {planData?.data?.classPlan?.title ?? "Learning Program"}
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Class Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>
                {planData?.data?.classPlan?.durationInMonths ?? 1} months
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Max Participants</div>
              <div>
                {planData?.data?.classPlan?.maxParticipants ?? 10} students
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Calls per Week</div>
              <div>{planData?.data?.classPlan?.callsPerWeek ?? 1} calls</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Video Meetings</div>
              <div>
                {planData?.data?.classPlan?.videoMeetings ?? 1} per month
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Email Support</div>
              <div>{planData?.data?.classPlan?.emailSupport ?? "General"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Certificate</div>
              <div>
                {planData?.data?.classPlan?.certificateProvided ? "Yes" : "No"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Topics</div>
              <div>
                {planData?.data?.classPlan?.topics
                  ?.map((topic) => topic.name)
                  .join(", ") ?? "General"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planData?.data?.classPlan?.language ?? "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planData?.data?.classPlan?.level ?? "Beginner"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{planData?.data?.classPlan?.prerequisites ?? "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{planData?.data?.classPlan?.materialProvided ?? "None"}</div>
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-4">
          <div className="font-semibold">Course Content</div>
          <div className="grid gap-4">
            {planData?.data?.classPlan?.classContents?.map((content, index) => (
              <div key={content.id} className="grid gap-1">
                <div className="font-medium">
                  Module {index + 1}: {content.title}
                </div>
                <div className="text-sm text-muted-foreground">
                  {content.description}
                </div>
                <div className="text-sm text-muted-foreground">
                  Duration: {content.hoursAllotted} hours
                </div>
              </div>
            ))}
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
                <div className="font-medium">CLASS25</div>
                <div className="text-sm text-muted-foreground">
                  Get 25% off your class registration
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">25% off</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-8 overflow-y-auto">
        <Card>
          <CardHeader>
            <CardTitle>Class Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Course Fee</div>
                <div>${planData?.data?.classPlan?.price ?? 500}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>
                      {planData?.data?.classPlan?.callsPerWeek ?? 1} calls per
                      week
                    </li>
                    <li>
                      {planData?.data?.classPlan?.videoMeetings ?? 1} video
                      meetings
                    </li>
                    <li>
                      {planData?.data?.classPlan?.emailSupport ?? "General"}{" "}
                      email support
                    </li>
                    <li>Course materials</li>
                    {planData?.data?.classPlan?.certificateProvided && (
                      <li>Completion certificate</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>${planData?.data?.classPlan?.price ?? 500}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax (10%)</div>
                <div>
                  $
                  {((planData?.data?.classPlan?.price ?? 500) * 0.1).toFixed(2)}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>Discount (25%)</div>
                <div>
                  -$
                  {((planData?.data?.classPlan?.price ?? 500) * 0.25).toFixed(
                    2,
                  )}
                </div>
              </div>
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Net Amount</div>
                <div>
                  $
                  {((planData?.data?.classPlan?.price ?? 500) * 0.85).toFixed(
                    2,
                  )}
                </div>
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
                  {gateway.gateway === "RAZORPAY" && planData ? (
                    <RazorpayCheckout
                      checkoutData={createCheckoutData({
                        appointmentType: "CLASS",
                        planId: planData.data.classPlan.id,
                        eventId: resolvedParams.classId,
                        paymentGateway: "RAZORPAY",
                        discountCode: Array.isArray(
                          resolvedSearchParams.discountCode,
                        )
                          ? resolvedSearchParams.discountCode[0]
                          : resolvedSearchParams.discountCode,
                      })}
                      onPaymentSuccess={(response: {
                        razorpay_payment_id: string;
                      }) => {
                        toast({
                          title: "Payment Successful",
                          description: `Payment ID: ${response.razorpay_payment_id}`,
                        });
                        window.location.href = "/dashboard/consultee";
                      }}
                      onPaymentError={(error: { description: string }) => {
                        toast({
                          title: "Payment Failed",
                          description:
                            error.description || "An unknown error occurred",
                          variant: "destructive",
                        });
                      }}
                    />
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => handleCheckout(gateway.gateway)}
                      disabled={isCheckoutProcessing}
                    >
                      {isCheckoutProcessing &&
                      processingGateway === gateway.gateway ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2"></div>
                          Processing...
                        </>
                      ) : (
                        `Pay with ${gateway.name}`
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
