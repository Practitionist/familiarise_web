"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";
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
import {
  SearchParams,
  searchParamsSchema,
  createCheckoutData,
  type SupportedCheckoutGateway,
} from "@/schemas/checkout";
import { Check, CreditCard as CreditCardIcon, Lock } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  createHandleCheckoutSuccess,
  createRazorpayCheckoutHandlers,
  createStripeCheckoutHandlers,
  handleUnifiedCheckout,
  paymentGateways,
  reportPaymentsError,
} from "../../utils";
import { calculatePricing, formatPercentage } from "../../math";
import { useCurrency } from "@/hooks/useCurrency";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import { GroupSessionDisclosure } from "@/components/booking/GroupSessionDisclosure";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import { EmiHint } from "@/app/checkout/components/CheckoutFlags";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";
import { deriveBatchCards } from "@/lib/booking/batch-cards";
import { sessionsBoughtLabel } from "@/lib/booking/class-enrolment";

import type {
  Appointment,
  ClassContent,
  ClassPlan,
  ConsultantProfile,
  Domain,
  Class as PrismaClass,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  AppointmentOccurrence,
  SubDomain,
  User,
} from "@prisma/client";

// price arrives as number: extended client + JSON serialization (#780)
export type CheckoutClassPlanData = Omit<ClassPlan, "price"> & {
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
  // #1554 — one wrapper per batch; the seat ids feed the capacity count.
  classes: (PrismaClass & {
    appointment:
      | (Appointment & {
          occurrences: AppointmentOccurrence[];
          participants: { userId: string }[];
        })
      | null;
  })[];
  topics: PrismaTopic[];
  classContents: ClassContent[];
  type: "class";
  imageUrl: string;
};

type PlanResponse = {
  data: CheckoutClassPlanData;
};

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ClassCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
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
  const validatedSearchParams = useMemo((): SearchParams | null => {
    const result = searchParamsSchema.safeParse(resolvedSearchParams);
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
    queryFn: async (): Promise<PlanResponse> => {
      const response = await fetch(
        `/api/plans/classes/${resolvedParams.planId}`,
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

  // #1819 — the batch named by ?eventId= (never silently another one), else
  // the first joinable batch; its card carries the late-join price.
  const batch = useMemo(() => {
    const plan = planData?.data;
    if (!plan) return null;
    const cards = deriveBatchCards(plan, plan.classes, new Date(), {
      hostUserId: plan.consultantProfile?.userId,
    });
    const wanted = validatedSearchParams?.eventId;
    const pick = wanted
      ? cards.find((c) => c.classId === wanted)
      : cards.find((c) => c.canEnrol);
    return pick?.canEnrol ? pick : null;
  }, [planData, validatedSearchParams?.eventId]);
  const availableClassId = batch?.classId ?? null;
  const batchPricePaise =
    batch?.enrolment.state === "open"
      ? batch.enrolment.basePaise
      : planData?.data?.price || 0;

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
          amount: batchPricePaise,
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

  const handleApiError = useMemo(() => createHandleApiError(toast), [toast]);
  const handleCheckoutSuccess = useMemo(
    () => createHandleCheckoutSuccess(toast, "CLASS"),
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

      if (isProcessingRef.current || isCheckoutProcessing) {
        return;
      }
      isProcessingRef.current = true;

      try {
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        if (!validatedSearchParams) {
          throw new Error("Invalid class parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Class plan not found");
        }

        if (!availableClassId) {
          throw new Error(
            "No available class sessions. All sessions may be full, cancelled, or completed.",
          );
        }

        const checkoutData = createCheckoutData({
          appointmentType: "CLASS",
          planId: planData.data.id,
          eventId: availableClassId,
          discountCode: appliedDiscount?.code,
          displayCurrency: currency,
          paymentGateway: gateway,
          useReferralCredits: selectedOrganizationId
            ? false
            : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
          ...billingState.bodyField,
        });

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
          let errorTitle = "Unable to Complete Enrollment";
          let errorDescription = error.message;

          if (error.message.includes("Invalid class parameters")) {
            errorTitle = "Enrollment Link Error";
            errorDescription =
              "The enrollment information is incomplete. Please go back to the class page and click 'Enroll Now' again to ensure all required information is included.";
          } else if (error.message.includes("Class plan not found")) {
            errorTitle = "Class Not Found";
            errorDescription =
              "This class could not be found or may no longer be available. Please go back and select a different class, or contact support if you believe this is an error.";
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
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
        isProcessingRef.current = false;
      }
    },
    [
      isCheckoutProcessing,
      isMaintenanceBlocked,
      maintenanceBlockReason,
      resolvedSearchParams,
      planData?.data?.id,
      handleApiError,
      handleCheckoutSuccess,
      toast,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      billingState.bodyField,
      validatedSearchParams,
      currency,
      availableClassId,
    ],
  );

  // Calculate pricing using the proper math functions
  // NOTE: This must be before early returns to maintain consistent hook order
  const pricing = useMemo(() => {
    const basePrice = batchPricePaise;
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
    batchPricePaise,
    appliedDiscount,
    useReferralCredits,
    availableCredits,
    checkoutTaxContext.isInternational,
    checkoutTaxContext.exportZeroRated,
  ]);

  // Periodic staleness check: detect if all class sessions have ended or been cancelled
  useEffect(() => {
    if (!planData?.data?.classes) return;

    const checkStaleness = () => {
      // #1819 — also stale once every batch is past its enrolment cutoff.
      const hasAvailable = deriveBatchCards(
        planData.data,
        planData.data.classes,
        new Date(),
        { hostUserId: planData.data.consultantProfile?.userId },
      ).some((c) => c.canEnrol);
      if (!hasAvailable) {
        setStaleError(
          "No batch of this class is open for enrolment. Batches may be full, closed to late joiners, cancelled, or completed.",
        );
      } else if (!batch) {
        setStaleError(
          "This batch is no longer open for enrolment. Please go back and choose another batch.",
        );
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [planData, batch]);

  if (isLoading) {
    return <CheckoutPlanSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)] bg-muted/40 p-4">
        <div
          className="rounded-2xl border border-border bg-card p-8 shadow-elevation-2 text-card-foreground max-w-md w-full text-center"
          role="alert"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <svg
              className="h-6 w-6 text-destructive"
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
          <p className="font-semibold text-lg mb-2 text-foreground">
            Unable to load checkout
          </p>
          <p className="text-muted-foreground text-sm">{error}</p>
          <Button
            variant="outline"
            onClick={() => window.history.back()}
            className="mt-5"
          >
            Go back
          </Button>
        </div>
      </div>
    );
  }

  const planDetails = planData?.data;
  const consultantDetails = planDetails?.consultantProfile;
  const userDetails = consultantDetails?.user;

  // The batch the checkout books; a late joiner's first session is the next one.
  const nextClassSession = planDetails?.classes
    ?.find((c) => c.id === availableClassId)
    ?.appointment?.occurrences?.filter(
      (o) =>
        !o.deletedAt &&
        o.completionStatus === "SCHEDULED" &&
        new Date(o.startsAt).getTime() > Date.now(),
    )
    .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0];

  if (!planData || !planDetails || !consultantDetails || !userDetails) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <p>Essential class data is missing. Please try again later.</p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[calc(100vh-3.5rem)] w-full lg:grid-cols-[58%_42%]">
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
                {consultantDetails?.headline ||
                  consultantDetails?.domain?.name ||
                  "Consultant"}
              </div>
              {userDetails?.workExperiences &&
                userDetails.workExperiences.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {userDetails.workExperiences.slice(0, 3).map((exp, i) => (
                      <CompanyLogo
                        key={`checkout-class-company-${i}`}
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
            <div className="font-semibold">Class</div>
            <div className="text-sm text-muted-foreground truncate">
              {planDetails?.title || "Online Class"}
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">Class Details</div>
          <div className="grid gap-2">
            {batch && (
              <div className="flex items-center justify-between gap-3">
                <div className="text-muted-foreground">Batch</div>
                <div className="text-right">{batch.label}</div>
              </div>
            )}
            {batch?.enrolment.state === "open" &&
              batch.enrolment.isLateJoin && (
                <div className="flex items-center justify-between gap-3">
                  <div className="text-muted-foreground">You are buying</div>
                  <div className="text-right">
                    {sessionsBoughtLabel(
                      batch.enrolment.remaining,
                      batch.enrolment.N,
                    )}
                  </div>
                </div>
              )}
            {nextClassSession && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">
                    Your first session
                  </div>
                  <div>
                    {new Date(nextClassSession.startsAt).toLocaleDateString(
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
                    {new Date(nextClassSession.startsAt).toLocaleTimeString()} -{" "}
                    {new Date(nextClassSession.endsAt).toLocaleTimeString()} (
                    {Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </div>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>
                {planDetails?.durationInMonths} month
                {planDetails?.durationInMonths !== 1 ? "s" : ""} (
                {planDetails?.totalSessions ||
                  planDetails?.durationInMonths * 4}{" "}
                sessions)
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Sessions per Week</div>
              <div>{planDetails?.sessionsPerWeek || 2}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Max Participants</div>
              <div>{planDetails?.maxParticipants || "Unlimited"}</div>
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
          planType="CLASS"
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
        <Card className="rounded-2xl border-border shadow-elevation-1">
          <CardHeader>
            <CardTitle className="text-foreground">Class Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <div className="text-muted-foreground">Enrollment Fee</div>
                <div className="font-medium">{formatPrice(batchPricePaise)}</div>
              </div>
              <Separator className="bg-border" />
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Includes
                </div>
                <ul className="space-y-1.5 text-sm text-foreground">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>
                      {planDetails?.totalSessions ||
                        (planDetails?.sessionsPerWeek || 2) *
                          (planDetails?.durationInMonths || 1) *
                          4}{" "}
                      total sessions (
                      {planDetails?.totalHours ||
                        (planDetails?.sessionsPerWeek || 2) *
                          (planDetails?.durationInMonths || 1) *
                          4}{" "}
                      hours)
                    </span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>
                      {planDetails?.sessionsPerWeek || 2} sessions per week
                    </span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>Course materials</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>Certificate of completion</span>
                  </li>
                </ul>
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
              {/* #1780 D-6 — the host's free-cancellation window. */}
              <FreeCancellationLine
                startsAt={nextClassSession?.startsAt}
                windowHours={planDetails?.refundWindowHours}
                kind="class"
                className="text-xs text-muted-foreground"
              />
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
        <Card className="rounded-2xl border-border shadow-elevation-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-foreground">
              Payment Method
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Select your preferred payment method
            </p>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="divide-y divide-border">
              {paymentGateways.map((gateway) => (
                <div
                  key={gateway.name}
                  className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
                      <CreditCardIcon className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-foreground">
                        {gateway.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {gateway.description}
                      </div>
                    </div>
                  </div>
                  {gateway.isActive ? (
                    <div className="flex gap-2">
                      {availableClassId && gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CLASS",
                            planId: planDetails.id,
                            eventId: availableClassId,
                            paymentGateway: "RAZORPAY",
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
                      ) : availableClassId && gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CLASS",
                            planId: planDetails.id,
                            eventId: availableClassId,
                            paymentGateway: "STRIPE",
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
                    <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      Coming Soon
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span>
                256-bit SSL encrypted checkout. Additional international
                gateways coming soon.
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
