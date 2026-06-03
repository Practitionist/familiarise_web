"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useMaintenanceGuard } from "@/hooks/useMaintenanceGuard";
import { useToast } from "@/hooks/use-toast";
import { fetchReviews } from "@/lib/user";
import {
  CheckoutInput,
  SubscriptionSearchParams,
  checkoutResponseSchema,
  subscriptionSearchParamsSchema,
  createCheckoutData,
} from "@/schemas/checkout";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import {
  ConsultantProfile,
  ConsultantReview,
  SubscriptionPlan,
  PaymentGateway,
} from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  createRazorpayCheckoutHandlers,
  createStripeCheckoutHandlers,
} from "../../utils";
import { calculatePricing, formatPercentage } from "../../math";
import { useCurrency } from "@/hooks/useCurrency";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";

type SubscriptionPlanWithConsultant = SubscriptionPlan & {
  consultantProfile: ConsultantProfile & {
    user: {
      id: string;
      name: string;
      email: string;
      image: string;
      workExperiences?: Array<{
        company: string;
        companyDomain: string | null;
        isCurrent: boolean;
      }>;
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

  const { formatPrice, currency } = useCurrency();
  const checkoutTaxContext = useCheckoutTaxContext();
  const [planData, setPlanData] = useState<SubscriptionResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, setReviews] = useState<ConsultantReview[]>([]);
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const isProcessingRef = useRef(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [appliedDiscount, setAppliedDiscount] =
    useState<AppliedDiscount | null>(null);
  const [isApplyingDiscount, setIsApplyingDiscount] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [useReferralCredits, setUseReferralCredits] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [availableCredits, setAvailableCredits] = useState(0);
  const [isLoadingCredits, setIsLoadingCredits] = useState(true);

  const { toast } = useToast();
  const {
    isBlocked: isMaintenanceBlocked,
    blockReason: maintenanceBlockReason,
  } = useMaintenanceGuard();

  // Validate search params once with Zod — single source of truth for all checkout flows
  const validatedSearchParams = useMemo((): SubscriptionSearchParams | null => {
    const result = subscriptionSearchParamsSchema.safeParse(resolvedSearchParams);
    return result.success ? result.data : null;
  }, [resolvedSearchParams]);

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
    } catch (_error) {
      setDiscountError("Failed to validate discount code");
    } finally {
      setIsApplyingDiscount(false);
    }
  };

  // Fetch available referral credits
  useEffect(() => {
    async function fetchCredits() {
      try {
        const response = await fetch("/api/referrals/credits/available");
        if (response.ok) {
          const data = await response.json();
          setAvailableCredits(
            data.data.totalAvailable || 0, // already in paise
          );
        }
      } catch (error) {
        console.error("Error fetching referral credits:", error);
      } finally {
        setIsLoadingCredits(false);
      }
    }
    fetchCredits();
  }, []);

  // Create utility functions using the toast instance
  const handleApiError = useMemo(() => createHandleApiError(toast), [toast]);
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

  // Common API request logic
  const makeCheckoutRequest = useCallback(async (
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
  }, []);

  const handleCheckout = useCallback(
    async (gateway: PaymentGateway, isMockPayment: boolean = false) => {
      // Block checkout during maintenance mode
      if (isMaintenanceBlocked) {
        toast({
          title: "Checkout unavailable",
          description:
            maintenanceBlockReason ?? "Service temporarily unavailable",
          variant: "destructive",
        });
        return;
      }

      // Prevent double-clicks: ref provides synchronous guard (React state is async)
      if (isProcessingRef.current || isCheckoutProcessing) {
        return;
      }
      isProcessingRef.current = true;

      try {
        // Set loading state
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        // Validate search params using the shared schema
        // Use pre-validated search params
        if (!validatedSearchParams) {
          throw new Error("Invalid subscription parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Subscription plan not found");
        }

        if (
          !validatedSearchParams.schedulingPeriodStartsAt ||
          !validatedSearchParams.schedulingPeriodEndsAt
        ) {
          throw new Error(
            "Scheduling period dates are required for subscriptions",
          );
        }

        // Staleness check: verify scheduling period hasn't expired
        const periodEnd = new Date(validatedSearchParams.schedulingPeriodEndsAt);
        if (periodEnd.getTime() < Date.now()) {
          throw new Error(
            "The scheduling period has expired. Please go back and select new dates.",
          );
        }

        const checkoutData = createCheckoutData({
          appointmentType: "SUBSCRIPTION",
          planId: planData.data.id,
          schedulingPeriodStartsAt: validatedSearchParams.schedulingPeriodStartsAt,
          schedulingPeriodEndsAt: validatedSearchParams.schedulingPeriodEndsAt,
          discountCode: appliedDiscount?.code,
          paymentGateway: gateway,
          displayCurrency: currency,
          useReferralCredits: selectedOrganizationId ? false : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
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

        // handleCheckout is only invoked by the dev-only Mock Pay button (isMockPayment=true).
        // Real payments go through StripeCheckout/RazorpayCheckout components.
        // FIX #520: Also handle zero-amount payments (credits covered full cost)
        if (
          data.success &&
          (data.skipPayment || data.isMockPayment || data.isZeroAmountPayment)
        ) {
          toast({
            title: "✅ Subscription Activated Successfully!",
            description: data.isZeroAmountPayment
              ? "Payment completed via referral credits. Your subscription is now active."
              : data.isMockPayment
                ? "Mock payment processed. Your subscription is now active. Check your dashboard for details."
                : "Your subscription is now active. Check your dashboard for details.",
            variant: "default",
          });

          setTimeout(() => {
            window.location.href = "/dashboard";
          }, 2000);
        } else if (!data.success) {
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
        isProcessingRef.current = false;
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [
      isCheckoutProcessing,
      isMaintenanceBlocked,
      maintenanceBlockReason,
      planData?.data?.id,
      toast,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      validatedSearchParams,
      currency,
      handleApiError,
      makeCheckoutRequest,
    ],
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
      discountAmount,
      creditsApplied: useReferralCredits ? availableCredits : 0,
      isInternational: checkoutTaxContext.isInternational,
    });
  }, [
    planData?.data?.price,
    appliedDiscount,
    useReferralCredits,
    availableCredits,
    checkoutTaxContext.isInternational,
  ]);

  // Periodic staleness check: warn if scheduling period has expired
  useEffect(() => {
    const periodEndStr = resolvedSearchParams.schedulingPeriodEndsAt;
    if (!periodEndStr || typeof periodEndStr !== "string") return;

    const checkStaleness = () => {
      const periodEnd = new Date(periodEndStr);
      if (periodEnd.getTime() < Date.now()) {
        setError(
          "The scheduling period has expired. Please go back and select new dates.",
        );
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [resolvedSearchParams.schedulingPeriodEndsAt]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-zinc-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="col-span-full flex items-center justify-center min-h-screen bg-zinc-50">
        <div
          className="bg-zinc-900 border border-zinc-800 text-white p-8 max-w-md w-full mx-4 text-center rounded-xl shadow-xl"
          role="alert"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800">
            <svg
              className="h-6 w-6 text-zinc-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
              />
            </svg>
          </div>
          <p className="font-semibold text-lg mb-2">Unable to load checkout</p>
          <p className="text-zinc-400 text-sm">{error}</p>
          <button
            onClick={() => window.history.back()}
            className="mt-5 inline-flex items-center rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 transition-colors"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  const consultantDetails = planData?.data.consultantProfile;
  const userDetails = planData?.data.consultantProfile.user;

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
                {consultantDetails?.headline || "Consultant"}
              </div>
              {userDetails?.workExperiences &&
                userDetails.workExperiences.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {userDetails.workExperiences.slice(0, 3).map((exp, i) => (
                      <CompanyLogo
                        key={`checkout-sub-company-${i}`}
                        companyName={exp.company}
                        companyDomain={exp.companyDomain ?? undefined}
                        size={20}
                        className="border-zinc-200"
                      />
                    ))}
                  </div>
                )}
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
        <OrgPayerSelector
          selectedOrganizationId={selectedOrganizationId}
          planType="SUBSCRIPTION"
          planId={resolvedParams.planId}
          onSelect={(id) => {
            setSelectedOrganizationId(id);
            if (id) setUseReferralCredits(false);
          }}
        />
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
                    : `${formatPrice(appliedDiscount.discountValue)} off`}
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
        <Separator className="bg-zinc-200" />
        <div className="grid gap-4">
          <div className="font-semibold">Referral Credits</div>
          {isLoadingCredits ? (
            <div className="text-sm text-muted-foreground">
              Loading credits...
            </div>
          ) : availableCredits > 0 ? (
            <div className="flex items-center justify-between bg-blue-50 p-3 rounded-lg border border-blue-200">
              <div>
                <div className="font-medium text-blue-700">
                  {formatPrice(availableCredits)} available
                </div>
                <div className="text-sm text-blue-600">
                  Apply to this purchase
                </div>
              </div>
              <Switch
                checked={useReferralCredits}
                onCheckedChange={setUseReferralCredits}
              />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No referral credits available
            </div>
          )}
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
                <div>{formatPrice(planData?.data?.price || 100)}</div>
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
                <div>{formatPrice(pricing.subtotal)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax ({formatPercentage(pricing.taxRate)})</div>
                <div>{formatPrice(pricing.taxAmount)}</div>
              </div>
              {pricing.discountAmount > 0 && (
                <div className="flex items-center justify-between text-green-600">
                  <div>
                    Discount{" "}
                    {pricing.discountPercent > 0 &&
                      `(${formatPercentage(pricing.discountPercent)})`}
                  </div>
                  <div>-{formatPrice(pricing.discountAmount)}</div>
                </div>
              )}
              {pricing.creditsApplied > 0 && (
                <div className="flex items-center justify-between text-blue-600">
                  <div>Referral Credits</div>
                  <div>-{formatPrice(pricing.creditsApplied)}</div>
                </div>
              )}
              <Separator className="bg-zinc-200" />
              <div className="flex items-center justify-between font-semibold">
                <div>Total</div>
                <div>{formatPrice(pricing.total)}</div>
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
          {[
            {
              name: "Stripe",
              description: "Card payments (international)",
              gateway: "STRIPE" as const,
              isActive: true,
            },
            {
              name: "Razorpay",
              description: "UPI, cards & bank transfer",
              gateway: "RAZORPAY" as const,
              isActive: true,
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
                      {validatedSearchParams?.schedulingPeriodStartsAt &&
                       validatedSearchParams?.schedulingPeriodEndsAt &&
                       gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "SUBSCRIPTION",
                            planId: planData?.data?.id || "",
                            paymentGateway: "RAZORPAY",
                            schedulingPeriodStartsAt: validatedSearchParams.schedulingPeriodStartsAt,
                            schedulingPeriodEndsAt: validatedSearchParams.schedulingPeriodEndsAt,
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            useReferralCredits: selectedOrganizationId ? false : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                          })}
                          onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                          onPaymentError={razorpayHandlers.onPaymentError}
                          disabled={isMaintenanceBlocked}
                        />
                      ) : validatedSearchParams?.schedulingPeriodStartsAt &&
                        validatedSearchParams?.schedulingPeriodEndsAt &&
                        gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "SUBSCRIPTION",
                            planId: planData?.data?.id || "",
                            paymentGateway: "STRIPE",
                            schedulingPeriodStartsAt: validatedSearchParams.schedulingPeriodStartsAt,
                            schedulingPeriodEndsAt: validatedSearchParams.schedulingPeriodEndsAt,
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            useReferralCredits: selectedOrganizationId ? false : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                          })}
                          onPaymentSuccess={stripeHandlers.onPaymentSuccess}
                          onPaymentError={stripeHandlers.onPaymentError}
                          disabled={isMaintenanceBlocked}
                        />
                      ) : null}
                      {process.env.NODE_ENV === "development" && (
                        <Button
                          variant="secondary"
                          onClick={() => handleCheckout(gateway.gateway, true)}
                          disabled={isCheckoutProcessing || isMaintenanceBlocked}
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
                      )}
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
