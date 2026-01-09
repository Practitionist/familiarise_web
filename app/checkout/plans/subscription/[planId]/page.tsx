"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { fetchReviews } from "@/lib/user";
import {
  CheckoutInput,
  checkoutResponseSchema,
  subscriptionSearchParamsSchema,
  createCheckoutData,
} from "@/schemas/checkout";
import {
  ConsultantProfile,
  ConsultantReview,
  SubscriptionPlan,
  PaymentGateway,
} from "@prisma/client";
import { loadStripe } from "@stripe/stripe-js";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  paymentGateways,
  createStripeCheckoutHandlers,
  createRazorpayCheckoutHandlers,
} from "../../utils";
import { calculatePricing, formatCurrency, formatPercentage } from "../../math";

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
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [appliedDiscount, setAppliedDiscount] = useState<{
    code: string;
    discountType: "PERCENTAGE" | "FIXED_AMOUNT";
    discountValue: number;
    discountAmount?: number;
  } | null>(null);
  const [isApplyingDiscount, setIsApplyingDiscount] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);

  const { toast } = useToast();

  // Apply discount code
  const handleApplyDiscount = async (code?: string) => {
    const codeToApply = code || discountCodeInput;
    if (!codeToApply.trim()) {
      setDiscountError("Please enter a discount code");
      return;
    }

    setIsApplyingDiscount(true);
    setDiscountError(null);

    try {
      const response = await fetch("/api/payments/discounts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: codeToApply,
          amount: planData?.data?.price || 0,
        }),
      });

      const data = await response.json();

      if (data.valid) {
        setAppliedDiscount({
          code: data.code,
          discountType: data.discountType,
          discountValue: data.discountValue,
          discountAmount: data.discountAmount,
        });
        setDiscountCodeInput("");
        toast({
          title: "Discount Applied",
          description: data.message,
        });
      } else {
        setDiscountError(data.message || "Invalid discount code");
      }
    } catch (error) {
      setDiscountError("Failed to validate discount code");
    } finally {
      setIsApplyingDiscount(false);
    }
  };

  // Create utility functions using the toast instance
  const handleApiError = createHandleApiError(toast);
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

  // Common API request logic
  const makeCheckoutRequest = async (
    checkoutData: CheckoutInput,
    isMockPayment: boolean = false,
  ) => {
    return fetch("/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...checkoutData, isMockPayment }),
    });
  };

  const handleCheckout = useCallback(
    async (gateway: PaymentGateway, isMockPayment: boolean = false) => {
      // Prevent double-clicks and multiple simultaneous requests
      if (isCheckoutProcessing) {
        return;
      }

      try {
        // Set loading state
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        // Validate search params using the shared schema
        const searchParamsValidation =
          subscriptionSearchParamsSchema.safeParse(resolvedSearchParams);
        if (!searchParamsValidation.success) {
          throw new Error("Invalid subscription parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Subscription plan not found");
        }

        // Validate that scheduling period dates are present
        if (
          !searchParamsValidation.data.schedulingPeriodStartsAt ||
          !searchParamsValidation.data.schedulingPeriodEndsAt
        ) {
          throw new Error(
            "Scheduling period dates are required for subscriptions",
          );
        }

        // Create checkout data using the shared utility with scheduling period
        const checkoutData = createCheckoutData({
          appointmentType: "SUBSCRIPTION",
          planId: planData.data.id,
          schedulingPeriodStartsAt:
            searchParamsValidation.data.schedulingPeriodStartsAt,
          schedulingPeriodEndsAt:
            searchParamsValidation.data.schedulingPeriodEndsAt,
          discountCode: appliedDiscount?.code,
          paymentGateway: gateway,
        });

        // Make API call - backend decides dev vs prod flow
        const response = await makeCheckoutRequest(checkoutData, isMockPayment);

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

        // Handle response based on what backend returns
        if (data.success) {
          if (data.skipPayment || data.isMockPayment) {
            // Development mode or mock payment - direct subscription success
            toast({
              title: "✅ Subscription Activated Successfully!",
              description: data.isMockPayment
                ? "Mock payment processed. Your subscription is now active. Check your dashboard for details."
                : "Your subscription is now active. Check your dashboard for details.",
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
              description:
                "Redirecting to secure payment gateway. Complete your payment to activate the subscription.",
              variant: "default",
            });

            // Small delay to let user see the toast before redirect
            setTimeout(async () => {
              // Handle gateway-specific responses
              switch (gateway) {
                case "STRIPE":
                  const stripe = await loadStripe(
                    process.env.NEXT_PUBLIC_STRIPE_KEY!,
                  );
                  await stripe?.confirmPayment({
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
          }
        } else {
          handleApiError({ error: data.error, errorType: data.errorType });
        }
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
    [isCheckoutProcessing, resolvedSearchParams, planData?.data?.id, toast],
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

  // Calculate pricing using the proper math functions
  // NOTE: This must be before early returns to maintain consistent hook order
  const pricing = useMemo(() => {
    const basePrice = planData?.data?.price || 0;
    let discountPercent = 0;
    let discountAmount = 0;
    if (appliedDiscount) {
      // Use the pre-calculated discountAmount from API if available
      // This already includes the maxDiscount cap
      if (appliedDiscount.discountAmount !== undefined) {
        discountAmount = appliedDiscount.discountAmount;
      } else if (appliedDiscount.discountType === "PERCENTAGE") {
        discountPercent = appliedDiscount.discountValue / 100;
      } else if (appliedDiscount.discountType === "FIXED_AMOUNT") {
        discountAmount = appliedDiscount.discountValue;
      }
    }
    return calculatePricing(basePrice, {
      discountPercent: discountAmount > 0 ? 0 : discountPercent,
      discountAmount
    });
  }, [planData?.data?.price, appliedDiscount]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-zinc-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50">
        <div
          className="bg-zinc-900 border border-zinc-800 text-white p-6 max-w-lg mx-auto text-center rounded-xl shadow-xl"
          role="alert"
        >
          <p className="font-bold text-lg mb-2">Oops! Something went wrong</p>
          <p className="text-zinc-400">{error}</p>
          <p className="mt-3 text-zinc-500 text-sm">
            Please check your selection and try again. If the problem persists,
            contact support.
          </p>
        </div>
      </div>
    );
  }

  const consultantDetails = planData?.data.consultantProfile;
  const userDetails = planData?.data.consultantProfile.user;
  const currency = planData?.data?.priceCurrency || "INR";

  return (
    <>
      <div className="flex flex-col gap-6 border-r border-zinc-300 bg-gradient-to-br from-zinc-200 via-zinc-100 to-gray-200 p-8">
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
        <Separator className="bg-zinc-200" />
        <div className="grid gap-2">
          <div className="font-semibold">Subscription Details</div>
          <div className="grid gap-2">
            {/* Scheduling Period */}
            {typeof resolvedSearchParams.schedulingPeriodStartsAt ===
              "string" &&
              typeof resolvedSearchParams.schedulingPeriodEndsAt ===
              "string" && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="text-muted-foreground">
                      Scheduling Period
                    </div>
                    <div className="text-right text-sm">
                      {new Date(
                        resolvedSearchParams.schedulingPeriodStartsAt,
                      ).toLocaleDateString()}{" "}
                      →{" "}
                      {new Date(
                        resolvedSearchParams.schedulingPeriodEndsAt,
                      ).toLocaleDateString()}
                    </div>
                  </div>
                  <Separator className="bg-zinc-200" />
                </>
              )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{planData?.data?.durationInMonths || 1} months</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Calls per Week</div>
              <div>{planData?.data?.callsPerWeek || 1} calls</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Session Duration</div>
              <div>{planData?.data?.sessionDurationInHours || 1} hour(s)</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Total Sessions</div>
              <div>
                {planData?.data?.totalSessions ||
                  (planData?.data?.callsPerWeek || 1) *
                  (planData?.data?.durationInMonths || 1) *
                  4}{" "}
                sessions
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Total Hours</div>
              <div>
                {planData?.data?.totalHours ||
                  (planData?.data?.callsPerWeek || 1) *
                  (planData?.data?.durationInMonths || 1) *
                  4 *
                  (planData?.data?.sessionDurationInHours || 1)}{" "}
                hours
              </div>
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
        <Separator className="bg-zinc-200" />
        <div className="grid gap-4">
          <div className="font-semibold">Discount Codes</div>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="Enter discount code"
              className="flex-1"
              value={discountCodeInput}
              onChange={(e) => setDiscountCodeInput(e.target.value)}
              disabled={isApplyingDiscount || !!appliedDiscount}
            />
            <Button
              variant="outline"
              onClick={() => handleApplyDiscount()}
              disabled={isApplyingDiscount || !!appliedDiscount}
            >
              {isApplyingDiscount ? "Applying..." : "Apply"}
            </Button>
          </div>
          {discountError && (
            <div className="text-sm text-red-500">{discountError}</div>
          )}
          {appliedDiscount && (
            <div className="flex items-center justify-between bg-green-50 p-3 rounded-md">
              <div>
                <div className="font-medium text-green-700">
                  {appliedDiscount.code}
                </div>
                <div className="text-sm text-green-600">
                  {appliedDiscount.discountType === "PERCENTAGE"
                    ? `${appliedDiscount.discountValue}% off`
                    : `${formatCurrency(appliedDiscount.discountValue, currency)} off`}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAppliedDiscount(null);
                  setDiscountError(null);
                }}
              >
                Remove
              </Button>
            </div>
          )}
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyDiscount("SUB20")}
                  disabled={isApplyingDiscount || !!appliedDiscount}
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-8 bg-white">
        <Card className="border-zinc-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-zinc-900">
              Subscription Pricing
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Monthly Fee</div>
                <div>
                  {formatCurrency(planData?.data?.price || 100, currency)}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>
                      {planData?.data?.totalSessions ||
                        (planData?.data?.callsPerWeek || 1) *
                        (planData?.data?.durationInMonths || 1) *
                        4}{" "}
                      total sessions (
                      {planData?.data?.totalHours ||
                        (planData?.data?.callsPerWeek || 1) *
                        (planData?.data?.durationInMonths || 1) *
                        4 *
                        (planData?.data?.sessionDurationInHours || 1)}{" "}
                      hours)
                    </li>
                    <li>{planData?.data?.callsPerWeek || 1} calls per week</li>
                    <li>
                      {planData?.data?.sessionDurationInHours || 1} hour
                      sessions
                    </li>
                    <li>
                      {planData?.data?.emailSupport || "General"} email support
                    </li>
                    <li>Learning materials</li>
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-zinc-200" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>{formatCurrency(pricing.subtotal, currency)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax ({formatPercentage(pricing.taxRate)})</div>
                <div>{formatCurrency(pricing.taxAmount, currency)}</div>
              </div>
              {pricing.discountAmount > 0 && (
                <div className="flex items-center justify-between text-green-600">
                  <div>
                    Discount{" "}
                    {pricing.discountPercent > 0 &&
                      `(${formatPercentage(pricing.discountPercent)})`}
                  </div>
                  <div>-{formatCurrency(pricing.discountAmount, currency)}</div>
                </div>
              )}
              <Separator className="bg-zinc-200" />
              <div className="flex items-center justify-between font-semibold">
                <div>Total</div>
                <div>{formatCurrency(pricing.total, currency)}</div>
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
          {/* Priority Gateways: Stripe and Razorpay with Real + Mock Payment */}
          {[
            {
              name: "Stripe",
              description: "International payments in USD",
              gateway: "STRIPE" as const,
              isActive: true,
            },
            {
              name: "Razorpay",
              description: "Indian payments in INR",
              gateway: "RAZORPAY" as const,
              isActive: true,
            },
            {
              name: "Lemon Squeezy",
              description: "Global payments in USD (Coming Soon)",
              gateway: "LEMON_SQUEEZY" as const,
              isActive: false,
            },
            {
              name: "Xflow",
              description: "Secure payments in USD (Coming Soon)",
              gateway: "XFLOW" as const,
              isActive: false,
            },
          ].map((gateway) => (
            <Card key={gateway.gateway} className="border-zinc-200">
              <CardHeader>
                <CardTitle className="text-zinc-900">{gateway.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <CreditCardIcon className="w-8 h-8 text-zinc-600" />
                    <div>
                      <div className="font-semibold text-zinc-900">
                        Credit/Debit Card
                      </div>
                      <div className="text-sm text-zinc-500">
                        {gateway.description}
                      </div>
                    </div>
                  </div>
                  {gateway.isActive ? (
                    <div className="flex gap-2">
                      {/* Real Payment Button */}
                      {gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "SUBSCRIPTION",
                            planId: planData?.data?.id || "",
                            paymentGateway: "STRIPE",
                            discountCode: appliedDiscount?.code,
                          })}
                          onPaymentSuccess={stripeHandlers.onPaymentSuccess}
                          onPaymentError={stripeHandlers.onPaymentError}
                        />
                      ) : gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "SUBSCRIPTION",
                            planId: planData?.data?.id || "",
                            paymentGateway: "RAZORPAY",
                            discountCode: appliedDiscount?.code,
                          })}
                          onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                          onPaymentError={razorpayHandlers.onPaymentError}
                        />
                      ) : null}
                      {/* Mock Payment Button */}
                      <Button
                        variant="secondary"
                        onClick={() => handleCheckout(gateway.gateway, true)}
                        disabled={isCheckoutProcessing}
                      >
                        {isCheckoutProcessing &&
                          processingGateway === `${gateway.gateway}-mock` ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2"></div>
                            Processing...
                          </>
                        ) : (
                          `Mock Pay (${gateway.name})`
                        )}
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" disabled>
                      Coming Soon
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
