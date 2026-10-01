"use client";

import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useMaintenanceGuard } from "@/hooks/useMaintenanceGuard";
import {
  ReferralCreditsBlock,
  useReferralCreditsBalance,
} from "@/app/checkout/components/referral-credits";
import { useToast } from "@/hooks/use-toast";
import { CheckoutPlanSkeleton } from "@/app/checkout/CheckoutSkeletons";
import {
  createCheckoutData,
  WebinarSearchParams,
  webinarSearchParamsSchema,
  type SupportedCheckoutGateway,
} from "@/schemas/checkout";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createHandleApiError,
  createHandleCheckoutSuccess,
  createRazorpayCheckoutHandlers,
  createStripeCheckoutHandlers,
  handleUnifiedCheckout,
  reportPaymentsError,
} from "../../utils";
import { calculatePricing } from "../../math";
import { getWebinarCapacity } from "@/lib/events/capacity";
import { useCurrency } from "@/hooks/useCurrency";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import {
  CheckoutConsultantHeader,
  CheckoutErrorState,
  CheckoutPaymentMethodsCard,
  CheckoutPricingBreakdown,
} from "@/app/checkout/components/CheckoutSharedSections";
import { GroupSessionDisclosure } from "@/components/booking/GroupSessionDisclosure";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";

import type {
  Appointment,
  ConsultantProfile,
  Domain,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  Webinar as PrismaWebinar,
  AppointmentOccurrence,
  SubDomain,
  User,
  WebinarPlan,
} from "@prisma/client";

// Define a type for the fetched WebinarPlan data.
// price arrives as number: extended client + JSON serialization (#780)
export type CheckoutWebinarPlanData = Omit<WebinarPlan, "price"> & {
  price: number;
  consultantProfile:
    | (ConsultantProfile & {
        user: User & {
          workExperiences?: Array<{
            company: string;
            companyDomain: string | null;
            isCurrent: boolean;
          }>;
        };
        domain: Domain | null;
        subDomains: SubDomain[];
        tags: PrismaTag[];
      })
    | null;
  webinars: (PrismaWebinar & {
    appointment:
      | (Appointment & {
          occurrences: AppointmentOccurrence[];
          // `participants` is what makes a seat count a seat (#1554) —
          // `fetchWebinarPlanDetail` includes it, and
          // `countWebinarParticipants` answers 0 in silence when it is absent.
          participants: { userId: string }[];
        })
      | null;
  })[];
  topics: PrismaTopic[];
  type: "webinar";
  imageUrl: string;
};

type PlanResponse = {
  data: CheckoutWebinarPlanData;
};

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function WebinarCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const { formatPrice, currency } = useCurrency();
  const checkoutTaxContext = useCheckoutTaxContext();
  const { availableCredits, isLoadingCredits, creditsLoadFailed } =
    useReferralCreditsBalance(
      checkoutTaxContext.referralCreditsLoaded,
      checkoutTaxContext.referralCreditsPaise,
    );
  const [staleError, setStaleError] = useState<string | null>(null);
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
  const validatedSearchParams = useMemo((): WebinarSearchParams | null => {
    const result = webinarSearchParamsSchema.safeParse(resolvedSearchParams);
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

  const checkoutPlanKey = useMemo(
    () => ["checkout-plan", resolvedParams.planId, searchParamsString] as const,
    [resolvedParams.planId, searchParamsString],
  );
  const queryClient = useQueryClient();

  // ONE cached read for the mount fetch (was a bare useEffect fetch).
  // Discount validation stays a click-time POST in handleApplyDiscount.
  const checkoutPlanQuery = useQuery({
    queryKey: checkoutPlanKey,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<PlanResponse> => {
      const response = await fetch(
        `/api/plans/webinars/${resolvedParams.planId}`,
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.data?.consultantProfile?.user) {
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
  const handleCheckoutSuccess = useMemo(
    () => createHandleCheckoutSuccess(toast, "WEBINAR"),
    [toast],
  );
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

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

        // Use pre-validated search params
        if (!validatedSearchParams) {
          throw new Error("Invalid webinar parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Webinar plan not found");
        }

        // Staleness check: validate the target webinar is still available
        const targetWebinar = planData.data.webinars?.find(
          (w) => w.id === validatedSearchParams.eventId,
        );
        if (!targetWebinar) {
          throw new Error("Webinar session not found.");
        }
        if (targetWebinar.status === "COMPLETED") {
          throw new Error("This webinar has already ended.");
        }
        if (targetWebinar.status === "CANCELLED") {
          throw new Error("This webinar has been cancelled.");
        }
        // Seats can go while this tab sits open. The server holds the real
        // gate under the allocation lock; this stops the buyer paying into a
        // rejection.
        if (
          getWebinarCapacity({
            webinar: targetWebinar,
            plan: { maxParticipants: planData.data.maxParticipants },
            excludeUserIds: planData.data.consultantProfile?.user?.id
              ? [planData.data.consultantProfile.user.id]
              : [],
          }).isFull
        ) {
          throw new Error("This webinar is now full.");
        }

        const checkoutData = createCheckoutData({
          appointmentType: "WEBINAR",
          planId: planData.data.id,
          eventId: validatedSearchParams.eventId,
          discountCode: appliedDiscount?.code,
          paymentGateway: gateway,
          displayCurrency: currency,
          useReferralCredits: selectedOrganizationId
            ? false
            : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
          ...billingState.bodyField,
        });

        // Handle unified checkout flow using the utility
        await handleUnifiedCheckout(
          checkoutData,
          gateway,
          handleApiError,
          handleCheckoutSuccess,
          isMockPayment,
        );
      } catch (error) {
        reportPaymentsError(error);
        console.error("Checkout error:", error);
        if (error instanceof Error) {
          // Provide more informative error messages based on the error type
          let errorTitle = "Unable to Complete Registration";
          let errorDescription = error.message;

          if (error.message.includes("Invalid webinar parameters")) {
            errorTitle = "Registration Link Error";
            errorDescription =
              "The registration information is incomplete. Please go back to the webinar page and click 'Register Now' again to ensure all required information is included.";
          } else if (error.message.includes("Webinar plan not found")) {
            errorTitle = "Webinar Not Found";
            errorDescription =
              "This webinar could not be found or may no longer be available. Please go back and select a different webinar, or contact support if you believe this is an error.";
          } else if (
            error.message.includes("network") ||
            error.message.includes("fetch")
          ) {
            errorTitle = "Connection Error";
            errorDescription =
              "Unable to connect to the server. Please check your internet connection and try again.";
          } else {
            errorDescription = `${error.message}. Please try again or contact support if the problem persists.`;
          }

          toast({
            title: errorTitle,
            description: errorDescription,
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
      planData?.data?.webinars,
      planData?.data?.maxParticipants,
      planData?.data?.consultantProfile?.user?.id,
      handleApiError,
      handleCheckoutSuccess,
      toast,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      billingState.bodyField,
      validatedSearchParams,
      currency,
    ],
  );

  /**
   * Re-check the seat count against the click, not the last render.
   *
   * The gate above lives inside `handleCheckout`, whose only production caller
   * is the development mock-pay button — the real Razorpay and Stripe controls
   * take `checkoutData` and open the gateway themselves. So the soft gate was
   * inert exactly where money moves: a webinar that filled while this tab sat
   * open still let the buyer pay into a rejection.
   *
   * `no-store` because the plan endpoint is cached `s-maxage=60`, and a
   * minute-old seat count is the thing being corrected. Refreshing `planData`
   * also re-derives `isSoldOut`, so both gateway buttons disable behind this.
   *
   * A failed check does NOT block the sale: the allocation lock on the server
   * is the authority, and refusing a paying customer because a display query
   * timed out trades a real sale for a race we do not own.
   */
  const revalidateSeatsBeforePayment = useCallback(async () => {
    if (!validatedSearchParams?.eventId) return true;
    try {
      const response = await fetch(
        `/api/plans/webinars/${resolvedParams.planId}`,
        { cache: "no-store" },
      );
      if (!response.ok) return true;
      const fresh: PlanResponse = await response.json();
      const freshWebinar = fresh.data?.webinars?.find(
        (w) => w.id === validatedSearchParams.eventId,
      );
      if (!fresh.data || !freshWebinar) return true;

      // Refresh the cached plan so isSoldOut re-derives behind this click.
      queryClient.setQueryData(checkoutPlanKey, fresh);

      if (
        freshWebinar.status === "COMPLETED" ||
        freshWebinar.status === "CANCELLED"
      ) {
        toast({
          title:
            freshWebinar.status === "COMPLETED"
              ? "This webinar has ended"
              : "This webinar has been cancelled",
          description:
            freshWebinar.status === "COMPLETED"
              ? "This webinar has already ended, so we stopped the payment before you were charged."
              : "This webinar has been cancelled, so we stopped the payment before you were charged.",
          variant: "destructive",
        });
        return false;
      }

      if (
        getWebinarCapacity({
          webinar: freshWebinar,
          plan: { maxParticipants: fresh.data.maxParticipants },
          excludeUserIds: fresh.data.consultantProfile?.user?.id
            ? [fresh.data.consultantProfile.user.id]
            : [],
        }).isFull
      ) {
        toast({
          title: "This webinar is now full",
          description:
            "The last seat went while this page was open, so we stopped the payment before you were charged.",
          variant: "destructive",
        });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }, [
    resolvedParams.planId,
    validatedSearchParams?.eventId,
    toast,
    queryClient,
    checkoutPlanKey,
  ]);

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

  // Periodic staleness check: detect if webinar has ended or been cancelled
  useEffect(() => {
    if (!planData?.data?.webinars) return;

    const eventId =
      typeof resolvedSearchParams.eventId === "string"
        ? resolvedSearchParams.eventId
        : undefined;

    const checkStaleness = () => {
      const targetWebinar = eventId
        ? planData.data.webinars.find((w) => w.id === eventId)
        : planData.data.webinars[0];

      if (!targetWebinar) return;

      if (targetWebinar.status === "COMPLETED") {
        setStaleError("This webinar has already ended.");
      } else if (targetWebinar.status === "CANCELLED") {
        setStaleError("This webinar has been cancelled.");
      } else if (targetWebinar.appointment?.occurrences?.[0]) {
        const firstSlotEnd = new Date(
          targetWebinar.appointment.occurrences[
            targetWebinar.appointment.occurrences.length - 1
          ].endsAt,
        );
        if (firstSlotEnd.getTime() < Date.now()) {
          setStaleError(
            "This webinar session has already ended. Please go back.",
          );
        }
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [planData, resolvedSearchParams.eventId]);

  if (isLoading) {
    return <CheckoutPlanSkeleton />;
  }

  if (error) {
    return <CheckoutErrorState error={error} />;
  }

  const planDetails = planData?.data;
  const consultantDetails = planDetails?.consultantProfile;
  const userDetails = consultantDetails?.user;

  // The instance being bought, not the plan's first one — ?eventId names it.
  const targetWebinar = validatedSearchParams?.eventId
    ? planDetails?.webinars?.find((w) => w.id === validatedSearchParams.eventId)
    : planDetails?.webinars?.[0];

  // Date and time of the session being paid for, for the same reason.
  const nextSession = targetWebinar?.appointment?.occurrences?.[0];

  // Seats, honestly. This line used to print the PLAN's maxParticipants, which
  // an instance override silently contradicts, and counted nobody — so a sold
  // out webinar advertised its full capacity and took the money anyway.
  const capacity =
    targetWebinar && planDetails
      ? getWebinarCapacity({
          webinar: targetWebinar,
          plan: { maxParticipants: planDetails.maxParticipants },
          excludeUserIds: userDetails?.id ? [userDetails.id] : [],
        })
      : null;
  const isSoldOut = capacity?.isFull ?? false;

  if (!planData || !planDetails || !consultantDetails || !userDetails) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <p>Essential webinar data is missing. Please try again later.</p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[calc(100vh-3.5rem)] w-full lg:grid-cols-[58%_42%]">
      <div className="flex flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <CheckoutConsultantHeader
          name={userDetails?.name}
          image={userDetails?.image}
          headline={
            consultantDetails?.headline || consultantDetails?.domain?.name
          }
          workExperiences={userDetails?.workExperiences}
          planTypeLabel="Webinar"
          planTitle={planDetails?.title || "Online Session"}
        />
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">Webinar Details</div>
          <div className="grid gap-2">
            {nextSession && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">Date</div>
                  <div>
                    {new Date(nextSession.startsAt).toLocaleDateString(
                      undefined,
                      {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">Time</div>
                  <div>
                    {new Date(nextSession.startsAt).toLocaleTimeString()} -{" "}
                    {new Date(nextSession.endsAt).toLocaleTimeString()} (
                    {Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </div>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{planDetails?.durationInHours || 1} hours</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Seats left</div>
              <div className={isSoldOut ? "font-medium text-red-600" : ""}>
                {capacity
                  ? isSoldOut
                    ? "Sold out"
                    : `${capacity.remaining} of ${capacity.max}`
                  : (planDetails?.maxParticipants ?? "—")}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planDetails?.language || "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planDetails?.level || "All Levels"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{planDetails?.prerequisites || "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{planDetails?.materialProvided || "None"}</div>
            </div>
          </div>
        </div>
        {/* #1852 decision 4 — shown before anyone picks who pays. */}
        <GroupSessionDisclosure />
        <Separator className="bg-border" />
        <OrgPayerSelector
          selectedOrganizationId={selectedOrganizationId}
          planType="WEBINAR"
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
              disabled={
                isApplyingDiscount ||
                !!appliedDiscount ||
                !discountCodeInput.trim()
              }
            >
              {isApplyingDiscount ? "Applying..." : "Apply"}
            </Button>
          </div>
          {discountError && (
            <div className="text-sm text-red-500">{discountError}</div>
          )}
          {appliedDiscount && (
            <div className="flex items-center justify-between gap-3 bg-green-50 p-3 rounded-lg border border-green-200">
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
                className="shrink-0 text-green-700 hover:text-green-800"
                onClick={() => {
                  setAppliedDiscount(null);
                  setDiscountError(null);
                }}
              >
                Remove
              </Button>
            </div>
          )}
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
      <div className="flex flex-col gap-6 p-6 sm:p-8 bg-card lg:sticky lg:top-6 lg:self-start">
        <CheckoutPricingBreakdown
          title="Webinar Pricing"
          feeLabel="Registration Fee"
          feeAmountPaise={planDetails?.price || 0}
          includes={[
            "Live webinar access",
            "Q&A session",
            "Recording access",
            "Certificate of attendance",
          ]}
          pricing={pricing}
          formatPrice={formatPrice}
          selectedOrganizationId={selectedOrganizationId}
          afterTotalNotice={
            <FreeCancellationLine
              startsAt={nextSession?.startsAt}
              windowHours={planDetails?.refundWindowHours}
              className="text-xs text-muted-foreground"
            />
          }
        />
        <CheckoutPaymentMethodsCard
          buildCheckoutData={(gateway) => {
            if (
              !validatedSearchParams ||
              !targetWebinar ||
              targetWebinar.status === "COMPLETED" ||
              targetWebinar.status === "CANCELLED"
            ) {
              return null;
            }
            return createCheckoutData({
              appointmentType: "WEBINAR",
              planId: planDetails.id,
              eventId: validatedSearchParams.eventId,
              paymentGateway: gateway,
              discountCode: appliedDiscount?.code,
              displayCurrency: currency,
              useReferralCredits: selectedOrganizationId
                ? false
                : useReferralCredits,
              organizationId: selectedOrganizationId ?? undefined,
              ...billingState.bodyField,
            });
          }}
          onRazorpaySuccess={razorpayHandlers.onPaymentSuccess}
          onRazorpayError={razorpayHandlers.onPaymentError}
          onStripeSuccess={stripeHandlers.onPaymentSuccess}
          onStripeError={stripeHandlers.onPaymentError}
          onMockPay={(gateway) => handleCheckout(gateway, true)}
          isCheckoutProcessing={isCheckoutProcessing}
          processingGateway={processingGateway}
          isMaintenanceBlocked={
            isMaintenanceBlocked ||
            !targetWebinar ||
            targetWebinar.status === "COMPLETED" ||
            targetWebinar.status === "CANCELLED"
          }
          isSoldOut={isSoldOut}
          onBeforeCheckout={revalidateSeatsBeforePayment}
        />
      </div>
    </div>
  );
}
