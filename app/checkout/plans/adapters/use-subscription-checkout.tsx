"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CancellationPolicyNote } from "@/components/booking/CancellationPolicyNote";
import { Separator } from "@/components/ui/separator";
import {
  PLAN_EMAIL_SUPPORT_LABEL,
  planLevelLabel,
} from "@/lib/labels/plan-labels";
import {
  planDurationText,
  planPriceLabel,
} from "@/lib/offerings/plan-length-copy";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import {
  planFeasibilitySchema,
  NOT_PLACEABLE_MESSAGE,
  subscriptionCheckoutBlocked,
  subscriptionCheckoutBlockedLabel,
} from "@/schemas/plan-feasibility";
import { PLAN_CLIENTS_FULL_MESSAGE } from "@/schemas/plan-clients";
import {
  subscriptionSearchParamsSchema,
  type SubscriptionSearchParams,
} from "@/schemas/checkout";

import type { ConsultantProfile, SubscriptionPlan } from "@prisma/client";

import {
  CheckoutDetailRow,
  type CheckoutPlanAdapter,
  type CheckoutSearchParams,
} from "../components/PlanCheckoutShell";
import { firstCycleWindow } from "@/lib/booking/entitlement";
import { CheckoutTotalNotes } from "../components/CheckoutTotals";
import { reportPaymentsError } from "../utils";
import { firstCycleLines } from "./first-cycle-lines";
import {
  loadErrorMessage,
  planIncludes,
  planLoadError,
  searchParamsKey,
} from "./shared";

// price arrives as number: extended client + JSON serialization
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

const DATE_PATTERN = "d MMM yyyy";

const START_PASSED =
  "The start date has passed. Please go back and pick a new one.";

function confirmationText(data: {
  isZeroAmountPayment?: boolean;
  isMockPayment?: boolean;
}): string {
  if (data.isZeroAmountPayment) {
    return "Nothing to pay. Your subscription is now active.";
  }
  if (data.isMockPayment) {
    return "Mock payment processed. Your subscription is now active. Check your dashboard for details.";
  }
  return "Your subscription is now active. Check your dashboard for details.";
}

export function useSubscriptionCheckout(
  planId: string,
  searchParams: CheckoutSearchParams,
): CheckoutPlanAdapter {
  const viewer = useViewerZone();
  const [staleError, setStaleError] = useState<string | null>(null);

  const validatedSearchParams = useMemo((): SubscriptionSearchParams | null => {
    const result = subscriptionSearchParamsSchema.safeParse(searchParams);
    return result.success ? result.data : null;
  }, [searchParams]);
  const searchParamsString = useMemo(
    () => searchParamsKey(searchParams),
    [searchParams],
  );

  const checkoutPlanQuery = useQuery({
    queryKey: ["checkout-plan", planId, searchParamsString],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<SubscriptionResponse> => {
      const response = await fetch(`/api/plans/subscriptions/${planId}`);
      if (!response.ok) {
        throw planLoadError(response.status);
      }
      const data = await response.json();
      if (!data.data.consultantProfile?.user) {
        throw new Error("Consultant details not found");
      }
      return data;
    },
  });
  const planData = checkoutPlanQuery.data ?? null;
  const plan = planData?.data;
  const consultantDetails = plan?.consultantProfile;

  useEffect(() => {
    if (checkoutPlanQuery.error) {
      reportPaymentsError(checkoutPlanQuery.error);
      console.error("Error fetching plan data:", checkoutPlanQuery.error);
    }
  }, [checkoutPlanQuery.error]);

  // Derive a default start when the buyer arrives without one (the plan-detail
  // "Subscribe" link is bare), so the payment controls always render. Only the
  // START travels: the window is the first cycle and the server derives it in
  // the consultant's zone; a client end is ignored there, so none is minted.
  const effectiveSearchParams = useMemo((): SubscriptionSearchParams | null => {
    if (!validatedSearchParams) return null;
    const { schedulingPeriodEndsAt: _ignored, ...rest } = validatedSearchParams;
    return {
      ...rest,
      schedulingPeriodStartsAt:
        rest.schedulingPeriodStartsAt ?? new Date().toISOString(),
    };
  }, [validatedSearchParams]);

  // The expert's room for this cadence over the first weeks, counting today's
  // bookings. Advisory: checkout itself refuses only an empty first week.
  const feasibilityQuery = useQuery({
    queryKey: [
      "plan-feasibility",
      planId,
      effectiveSearchParams?.schedulingPeriodStartsAt ?? null,
    ],
    enabled: Boolean(planId && effectiveSearchParams?.schedulingPeriodStartsAt),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const startsAt = effectiveSearchParams?.schedulingPeriodStartsAt;
      const qs = startsAt ? `?startsAt=${encodeURIComponent(startsAt)}` : "";
      const response = await fetch(
        `/api/plans/subscriptions/${planId}/feasibility${qs}`,
      );
      if (!response.ok) return null;
      return planFeasibilitySchema.parse(await response.json());
    },
  });
  const feasibility = feasibilityQuery.data ?? null;
  const isRenewal = !!effectiveSearchParams?.renewsSubscriptionId;
  // A renewal's first week starts at the old plan's end, which this read does not check.
  const firstWeekBlocked = !isRenewal && feasibility?.firstWeekPlaceable === 0;

  // The first cycle in the zone the server cuts it in (the expert's scheduling
  // zone, from the feasibility read), so the buyer reads the dates it stores.
  const cycleZone = feasibility?.zone ?? null;
  const startIso = effectiveSearchParams?.schedulingPeriodStartsAt;
  const sessionsPerWeekTerm = plan?.sessionsPerWeek ?? 1;
  const durationInMonthsTerm = plan?.durationInMonths ?? 1;
  const firstCycle = useMemo(
    () =>
      cycleZone && plan && startIso
        ? firstCycleLines(
            startIso,
            {
              sessionsPerWeek: sessionsPerWeekTerm,
              durationInMonths: durationInMonthsTerm,
            },
            cycleZone,
          )
        : null,
    [cycleZone, plan, startIso, sessionsPerWeekTerm, durationInMonthsTerm],
  );

  // The elapsed-start check must not wait on feasibility, so it falls back to
  // the viewer zone until the expert's zone arrives.
  const stalenessZone = cycleZone ?? viewer.zone;
  const cycleEnd = useMemo(
    () =>
      plan && startIso
        ? firstCycleWindow(
            {
              sessionsPerWeek: sessionsPerWeekTerm,
              durationInMonths: durationInMonthsTerm,
            },
            new Date(startIso),
            stalenessZone,
          ).end
        : null,
    [plan, startIso, sessionsPerWeekTerm, durationInMonthsTerm, stalenessZone],
  );

  // Periodic staleness check: warn once the first cycle has elapsed, and drop
  // that warning (only that one) when a later zone moves the end ahead again.
  useEffect(() => {
    if (!cycleEnd) return;
    const checkStaleness = () => {
      if (cycleEnd.getTime() < Date.now()) setStaleError(START_PASSED);
      else setStaleError((error) => (error === START_PASSED ? null : error));
    };
    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [cycleEnd]);

  const preflight = useCallback(() => {
    if (!effectiveSearchParams) {
      throw new Error("Invalid subscription parameters");
    }
    if (!planData?.data?.id) throw new Error("Subscription plan not found");
    if (!effectiveSearchParams.schedulingPeriodStartsAt) {
      throw new Error("A start date is required for subscriptions");
    }
    // The first cycle the buyer was shown must not have fully elapsed.
    if (cycleEnd && cycleEnd.getTime() < Date.now()) {
      throw new Error(START_PASSED);
    }
  }, [effectiveSearchParams, planData, cycleEnd]);

  const checkoutPlanFields = useMemo(
    () =>
      effectiveSearchParams?.schedulingPeriodStartsAt
        ? {
            appointmentType: "SUBSCRIPTION" as const,
            planId: plan?.id || "",
            schedulingPeriodStartsAt:
              effectiveSearchParams.schedulingPeriodStartsAt,
            renewsSubscriptionId: effectiveSearchParams.renewsSubscriptionId,
          }
        : null,
    [effectiveSearchParams, plan?.id],
  );

  const sessionsPerWeek = plan?.sessionsPerWeek || 1;
  const durationInMonths = plan?.durationInMonths || 1;
  const sessionDurationInHours = plan?.sessionDurationInHours || 1;
  const computedSessions = sessionsPerWeek * durationInMonths * 4;

  return {
    appointmentType: "SUBSCRIPTION",
    isLoading: checkoutPlanQuery.isPending,
    error: staleError ?? loadErrorMessage(checkoutPlanQuery.error),
    missingMessage: null,
    consultantProfileId: consultantDetails?.id,
    header: {
      user: consultantDetails?.user,
      headline: consultantDetails?.headline || "Consultant",
      typeLabel: "Subscription",
      title: plan?.title || "Monthly Plan",
    },
    detailsTitle: "Subscription Details",
    detailsBanner:
      isRenewal ||
      feasibility?.notice ||
      feasibility?.fullyBooked ||
      firstWeekBlocked ? (
        <div className="space-y-2">
          {effectiveSearchParams?.renewsSubscriptionId && (
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
              Renewing your existing subscription — your new period will start
              immediately after your current subscription ends
            </div>
          )}
          {feasibility?.fullyBooked ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
            >
              {PLAN_CLIENTS_FULL_MESSAGE}
            </div>
          ) : firstWeekBlocked ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
            >
              {NOT_PLACEABLE_MESSAGE}
            </div>
          ) : (
            feasibility?.notice && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                {feasibility.notice}
              </div>
            )
          )}
        </div>
      ) : null,
    detailRows: (
      <>
        {/* Start + first cycle: the buyer picked a start; the consultant
            schedules one cycle at a time from it. */}
        {typeof effectiveSearchParams?.schedulingPeriodStartsAt ===
          "string" && (
          <>
            <CheckoutDetailRow label="Starts" className="text-right text-sm">
              {firstCycle?.starts ??
                formatInViewerZone(
                  effectiveSearchParams.schedulingPeriodStartsAt,
                  viewer.zone,
                  DATE_PATTERN,
                )}
            </CheckoutDetailRow>
            {firstCycle && (
              <CheckoutDetailRow
                label="First cycle"
                className="text-right text-sm"
              >
                {firstCycle.cycle} · {sessionsPerWeek} session
                {sessionsPerWeek === 1 ? "" : "s"} per cycle ·{" "}
                {plan?.totalSessions ?? "—"} in the plan
              </CheckoutDetailRow>
            )}
            <Separator className="bg-border" />
          </>
        )}
        <CheckoutDetailRow label="Duration">
          {planDurationText(plan ?? {})}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Sessions per Week">
          {sessionsPerWeek} {sessionsPerWeek === 1 ? "session" : "sessions"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Session Duration">
          {sessionDurationInHours} hour(s)
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Total Sessions">
          {plan?.totalSessions || computedSessions} sessions
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Total Hours">
          {plan?.totalHours || computedSessions * sessionDurationInHours} hours
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Email Support">
          {PLAN_EMAIL_SUPPORT_LABEL[plan?.emailSupport ?? "GENERAL"]}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Language">
          {plan?.language || "English"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Level">
          {planLevelLabel(plan?.level ?? "BEGINNER")}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Prerequisites">
          {plan?.prerequisites || "None"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Material Provided">
          {plan?.materialProvided || "None"}
        </CheckoutDetailRow>
      </>
    ),
    groupDisclosure: false,
    basePricePaise: plan?.price || 0,
    pricingTitle: "Subscription Pricing",
    feeLabel: planPriceLabel(plan ?? {}),
    includes: planIncludes(plan?.whatsIncluded, [
      `${plan?.totalSessions || computedSessions} total sessions (${plan?.totalHours || computedSessions * sessionDurationInHours} hours)`,
      `${sessionsPerWeek} sessions per week`,
      `${sessionDurationInHours} hour sessions`,
      `${PLAN_EMAIL_SUPPORT_LABEL[plan?.emailSupport ?? "GENERAL"]} email support`,
    ]),
    renderFooter: (ctx) => (
      <>
        {/* Plans are paid at purchase; the 48 h promise. */}
        {ctx.taxContext.taxContextStatus === "loaded" && (
          <p className="text-xs text-muted-foreground">
            You pay {ctx.formatPrice(ctx.pricing.total)} now ·{" "}
            {consultantDetails?.user?.name ?? "Your expert"} schedules your
            first week within 48 h or you&apos;re refunded in full.
          </p>
        )}
        <CheckoutTotalNotes
          totalPaise={ctx.pricing.total}
          organizationId={ctx.selectedOrganizationId}
          taxContextStatus={ctx.taxContext.taxContextStatus}
        />
        {/* The notice ladder at purchase: the 48 h promise above is about the
            expert not scheduling; this is about the buyer changing their mind. */}
        <CancellationPolicyNote
          eventKind="individual"
          funding={ctx.purchaseFunding}
          viewerZone={viewer}
          className="border-t border-border pt-3 text-xs text-muted-foreground"
        />
      </>
    ),
    checkoutPlanFields,
    // The server's per-viewer answer: an existing client is never fully booked.
    soldOut: subscriptionCheckoutBlocked(feasibility, { renewal: isRenewal }),
    soldOutLabel: subscriptionCheckoutBlockedLabel(feasibility),
    mockFlow: {
      kind: "direct",
      successTitle: "✅ Subscription Activated Successfully!",
      confirmation: confirmationText,
    },
    preflight,
  };
}
