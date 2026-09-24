"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useMaintenanceGuard } from "@/hooks/useMaintenanceGuard";
import {
  ReferralCreditsBlock,
  useReferralCreditsBalance,
} from "@/app/checkout/components/referral-credits";
import { useToast } from "@/hooks/use-toast";
import { CheckoutPlanSkeleton } from "@/app/checkout/CheckoutSkeletons";
import { firstCycleWindow } from "@/lib/booking/entitlement";
import {
  CheckoutInput,
  SubscriptionSearchParams,
  checkoutResponseSchema,
  subscriptionSearchParamsSchema,
  createCheckoutData,
  type SupportedCheckoutGateway,
} from "@/schemas/checkout";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import { EmiHint } from "@/app/checkout/components/CheckoutFlags";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";
import { ConsultantProfile, SubscriptionPlan } from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  createRazorpayCheckoutHandlers,
  createStripeCheckoutHandlers,
  paymentGateways,
} from "../../utils";
import { calculatePricing, formatPercentage } from "../../math";
import { useCurrency } from "@/hooks/useCurrency";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";
import {
  mintClientIdempotencyKey,
  busyRetryToast,
  fetchCheckoutWithBusyRetry,
  reportPaymentsError,
} from "@/app/checkout/plans/utils";

// price arrives as number: extended client + JSON serialization (#780)
type SubscriptionPlanWithConsultant = Omit<SubscriptionPlan, "price"> & {
  price: number;
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
  const router = useRouter();

  const { formatPrice, currency } = useCurrency();
  const checkoutTaxContext = useCheckoutTaxContext();
  const { availableCredits, isLoadingCredits, creditsLoadFailed } =
    useReferralCreditsBalance(
      checkoutTaxContext.referralCreditsLoaded,
      checkoutTaxContext.referralCreditsPaise,
    );
  const [staleError, setStaleError] = useState<string | null>(null);
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  // #828 — useState's lazy initializer runs once per mount.
  const [idempotencyKey] = useState(mintClientIdempotencyKey);
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
  // #1365 — GST place of supply. Blank is the statutory s.12(2)(b) default, so
  // this never blocks checkout.
  const billingState = useBillingState(checkoutTaxContext.billingStateCode);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<
    string | null
  >(null);

  const { toast } = useToast();
  const {
    isBlocked: isMaintenanceBlocked,
    blockReason: maintenanceBlockReason,
  } = useMaintenanceGuard();

  // Validate search params once with Zod — single source of truth for all checkout flows
  const validatedSearchParams = useMemo((): SubscriptionSearchParams | null => {
    const result =
      subscriptionSearchParamsSchema.safeParse(resolvedSearchParams);
    return result.success ? result.data : null;
  }, [resolvedSearchParams]);

  // Stable string for the query key below.
  const searchParamsString = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(resolvedSearchParams)) {
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, v);
      } else if (value !== undefined) {
        params.append(key, value);
      }
    }
    return params.toString();
  }, [resolvedSearchParams]);

  // ONE cached read for the mount fetch (was a bare useEffect fetch).
  // Discount validation stays a click-time POST in handleApplyDiscount.
  const checkoutPlanQuery = useQuery({
    queryKey: ["checkout-plan", resolvedParams.planId, searchParamsString],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<SubscriptionResponse> => {
      const response = await fetch(
        `/api/plans/subscriptions/${resolvedParams.planId}`,
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.data.consultantProfile?.user) {
        throw new Error("Consultant details not found");
      }

      return data;
    },
  });

  const planData = checkoutPlanQuery.data ?? null;
  const isLoading = checkoutPlanQuery.isPending;
  const error =
    staleError ??
    (checkoutPlanQuery.error
      ? checkoutPlanQuery.error instanceof Error
        ? checkoutPlanQuery.error.message
        : "An unexpected error occurred. Please try again."
      : null);

  // Plan-load failures report exactly as the old fetch catch did.
  useEffect(() => {
    if (checkoutPlanQuery.error) {
      reportPaymentsError(checkoutPlanQuery.error);
      console.error("Error fetching plan data:", checkoutPlanQuery.error);
    }
  }, [checkoutPlanQuery.error]);

  // E2E-audit P0 fix — derive a default start when the buyer arrives
  // without one (the plan-detail "Subscribe" CTA links here bare), so the
  // payment controls never render null. #1766 — only the START travels: the
  // window is the first cycle and the server derives it in the consultant's
  // zone; a client end is ignored there, so none is minted here.
  const effectiveSearchParams = useMemo((): SubscriptionSearchParams | null => {
    if (!validatedSearchParams) return null;
    const { schedulingPeriodEndsAt: _ignored, ...rest } = validatedSearchParams;
    return {
      ...rest,
      schedulingPeriodStartsAt:
        rest.schedulingPeriodStartsAt ?? new Date().toISOString(),
    };
  }, [validatedSearchParams]);

  // The first cycle as the buyer will see it, in the browser's zone (display
  // only; the persisted window is the server's).
  const firstCycle = useMemo(() => {
    const plan = planData?.data;
    const start = effectiveSearchParams?.schedulingPeriodStartsAt;
    if (!plan || !start) return null;
    return firstCycleWindow(
      {
        sessionsPerWeek: plan.sessionsPerWeek ?? 1,
        durationInMonths: plan.durationInMonths ?? 1,
      },
      new Date(start),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }, [planData?.data, effectiveSearchParams?.schedulingPeriodStartsAt]);

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

  // Create utility functions using the toast instance
  const handleApiError = useMemo(() => createHandleApiError(toast), [toast]);
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

  // Common API request logic
  const makeCheckoutRequest = useCallback(
    async (checkoutData: CheckoutInput, isMockPayment: boolean = false) => {
      return fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...checkoutData,
          isMockPayment,
          // #828 — stable per-mount; the server dedupes retries on this key.
          clientIdempotencyKey: idempotencyKey,
        }),
      });
    },
    [idempotencyKey],
  );

  const handleCheckout = useCallback(
    async (
      gateway: SupportedCheckoutGateway,
      isMockPayment: boolean = false,
    ) => {
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
        // Use pre-validated search params (with the derived default period)
        if (!effectiveSearchParams) {
          throw new Error("Invalid subscription parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Subscription plan not found");
        }

        if (!effectiveSearchParams.schedulingPeriodStartsAt) {
          throw new Error("A start date is required for subscriptions");
        }

        // Staleness check: the first cycle the buyer was shown must not have
        // fully elapsed before they paid.
        if (firstCycle && firstCycle.end.getTime() < Date.now()) {
          throw new Error(
            "The start date has passed. Please go back and pick a new one.",
          );
        }

        const checkoutData = createCheckoutData({
          appointmentType: "SUBSCRIPTION",
          planId: planData.data.id,
          schedulingPeriodStartsAt:
            effectiveSearchParams.schedulingPeriodStartsAt,
          discountCode: appliedDiscount?.code,
          paymentGateway: gateway,
          displayCurrency: currency,
          useReferralCredits: selectedOrganizationId
            ? false
            : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
          ...billingState.bodyField,
        });

        // Make API call - backend decides dev vs prod flow
        // B5 — structured BUSY 409s auto-retry once (idempotency key dedupe-safe).
        const response = await fetchCheckoutWithBusyRetry(
          () => makeCheckoutRequest(checkoutData, isMockPayment),
          (waitSeconds) => toast(busyRetryToast(waitSeconds)),
        );

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
            router.push("/dashboard");
          }, 2000);
        } else if (!data.success) {
          handleApiError({ error: data.error, errorType: data.errorType });
        }
      } catch (error) {
        reportPaymentsError(error);
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
      router,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      billingState.bodyField,
      effectiveSearchParams,
      firstCycle,
      currency,
      handleApiError,
      makeCheckoutRequest,
    ],
  );

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
      exportZeroRated: checkoutTaxContext.exportZeroRated,
    });
  }, [
    planData?.data?.price,
    appliedDiscount,
    useReferralCredits,
    availableCredits,
    checkoutTaxContext.isInternational,
    checkoutTaxContext.exportZeroRated,
  ]);

  // Periodic staleness check: warn once the first cycle has elapsed.
  useEffect(() => {
    const cycleEnd = firstCycle?.end;
    if (!cycleEnd) return;

    const checkStaleness = () => {
      if (cycleEnd.getTime() < Date.now()) {
        setStaleError(
          "The start date has passed. Please go back and pick a new one.",
        );
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [firstCycle?.end]);

  if (isLoading) {
    return <CheckoutPlanSkeleton />;
  }

  if (error) {
    return (
      <div className="col-span-full flex items-center justify-center min-h-screen bg-muted">
        <div
          className="bg-foreground border border-border text-background p-8 max-w-md w-full mx-4 text-center rounded-xl shadow-xl"
          role="alert"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-background/10">
            <svg
              className="h-6 w-6 text-background/70"
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
          <p className="text-background/70 text-sm">{error}</p>
          <button
            onClick={() => window.history.back()}
            className="mt-5 inline-flex items-center rounded-lg bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
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
      <div className="flex flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <Avatar className="w-12 h-12 border shrink-0">
              <AvatarImage
                src={userDetails?.image || "/placeholder-user.jpg"}
                alt={userDetails?.name || "Consultant"}
              />
              <AvatarFallback>
                {userDetails?.name ? userDetails.name.charAt(0) : "C"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {userDetails?.name || "Consultant Name"}
              </div>
              <div className="text-sm text-muted-foreground truncate">
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
                        className="border-border"
                      />
                    ))}
                  </div>
                )}
            </div>
          </div>
          <div className="text-right min-w-0">
            <div className="font-semibold">Subscription</div>
            <div className="text-sm text-muted-foreground truncate">
              {planData?.data?.title || "Monthly Plan"}
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">Subscription Details</div>
          <div className="grid gap-2">
            {/* Start + first cycle (#1766): the buyer picked a start; the
                consultant schedules one cycle at a time from it. */}
            {typeof effectiveSearchParams?.schedulingPeriodStartsAt ===
              "string" && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">Starts</div>
                  <div className="text-right text-sm">
                    {new Date(
                      effectiveSearchParams.schedulingPeriodStartsAt,
                    ).toLocaleDateString()}
                  </div>
                </div>
                {firstCycle && (
                  <div className="flex items-center justify-between">
                    <div className="text-muted-foreground">First cycle</div>
                    <div className="text-right text-sm">
                      {firstCycle.start.toLocaleDateString()} →{" "}
                      {firstCycle.end.toLocaleDateString()} ·{" "}
                      {planData?.data?.sessionsPerWeek || 1} session
                      {(planData?.data?.sessionsPerWeek || 1) === 1
                        ? ""
                        : "s"}{" "}
                      per cycle · {planData?.data?.totalSessions ?? "—"} in the
                      plan
                    </div>
                  </div>
                )}
                <Separator className="bg-border" />
              </>
            )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{planData?.data?.durationInMonths || 1} months</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Sessions per Week</div>
              <div>
                {planData?.data?.sessionsPerWeek || 1}{" "}
                {(planData?.data?.sessionsPerWeek || 1) === 1
                  ? "session"
                  : "sessions"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Session Duration</div>
              <div>{planData?.data?.sessionDurationInHours || 1} hour(s)</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Total Sessions</div>
              <div>
                {planData?.data?.totalSessions ||
                  (planData?.data?.sessionsPerWeek || 1) *
                    (planData?.data?.durationInMonths || 1) *
                    4}{" "}
                sessions
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Total Hours</div>
              <div>
                {planData?.data?.totalHours ||
                  (planData?.data?.sessionsPerWeek || 1) *
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
        <Separator className="bg-border" />
        <OrgPayerSelector
          selectedOrganizationId={selectedOrganizationId}
          planType="SUBSCRIPTION"
          planId={resolvedParams.planId}
          onSelect={(id) => {
            setSelectedOrganizationId(id);
            if (id) setUseReferralCredits(false);
          }}
        />
        <Separator className="bg-border" />
        <BillingStateSelect
          value={billingState.value}
          onChange={billingState.onChange}
        />
        <Separator className="bg-border" />
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
            <div className="flex items-center justify-between gap-3 bg-green-50 p-3 rounded-md">
              <div className="min-w-0">
                <div className="font-medium text-green-700 truncate">
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
                className="shrink-0"
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
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">SUB20</div>
                <div className="text-sm text-muted-foreground">
                  Get 20% off your subscription
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
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
        <Separator className="bg-border" />
        <ReferralCreditsBlock
          availableCredits={availableCredits}
          isLoadingCredits={isLoadingCredits}
          creditsLoadFailed={creditsLoadFailed}
          useReferralCredits={useReferralCredits}
          onCheckedChange={setUseReferralCredits}
          formatPrice={formatPrice}
        />
      </div>
      <div className="flex flex-col gap-8 p-6 sm:p-8 bg-card">
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-foreground">
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
                        (planData?.data?.sessionsPerWeek || 1) *
                          (planData?.data?.durationInMonths || 1) *
                          4}{" "}
                      total sessions (
                      {planData?.data?.totalHours ||
                        (planData?.data?.sessionsPerWeek || 1) *
                          (planData?.data?.durationInMonths || 1) *
                          4 *
                          (planData?.data?.sessionDurationInHours || 1)}{" "}
                      hours)
                    </li>
                    <li>
                      {planData?.data?.sessionsPerWeek || 1} sessions per week
                    </li>
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
            <Separator className="bg-border" />
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
                <div className="flex items-center justify-between text-foreground">
                  <div>Referral Credits</div>
                  <div>-{formatPrice(pricing.creditsApplied)}</div>
                </div>
              )}
              <Separator className="bg-border" />
              <div className="flex items-center justify-between font-semibold">
                <div>Total</div>
                <div>{formatPrice(pricing.total)}</div>
              </div>
              <FxEstimateNote
                totalPaise={pricing.total}
                organizationId={selectedOrganizationId}
              />
              <EmiHint
                totalPaise={pricing.total}
                organizationId={selectedOrganizationId}
              />
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
          {paymentGateways.map((gateway) => (
            <Card key={gateway.gateway} className="border-border">
              <CardHeader>
                <CardTitle className="text-foreground">
                  {gateway.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-4 min-w-0">
                    <CreditCardIcon className="w-8 h-8 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">
                        Credit/Debit Card
                      </div>
                      <div className="text-sm text-muted-foreground/70">
                        {gateway.description}
                      </div>
                    </div>
                  </div>
                  {gateway.isActive ? (
                    <div className="flex gap-2">
                      {effectiveSearchParams?.schedulingPeriodStartsAt &&
                      gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "SUBSCRIPTION",
                            planId: planData?.data?.id || "",
                            paymentGateway: "RAZORPAY",
                            schedulingPeriodStartsAt:
                              effectiveSearchParams.schedulingPeriodStartsAt,
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            useReferralCredits: selectedOrganizationId
                              ? false
                              : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                            ...billingState.bodyField,
                          })}
                          onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                          onPaymentError={razorpayHandlers.onPaymentError}
                          disabled={isMaintenanceBlocked}
                        />
                      ) : effectiveSearchParams?.schedulingPeriodStartsAt &&
                        gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "SUBSCRIPTION",
                            planId: planData?.data?.id || "",
                            paymentGateway: "STRIPE",
                            schedulingPeriodStartsAt:
                              effectiveSearchParams.schedulingPeriodStartsAt,
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            useReferralCredits: selectedOrganizationId
                              ? false
                              : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                            ...billingState.bodyField,
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
                          disabled={
                            isCheckoutProcessing || isMaintenanceBlocked
                          }
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
