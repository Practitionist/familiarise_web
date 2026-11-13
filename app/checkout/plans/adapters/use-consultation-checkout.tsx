"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isSlotStillOffered } from "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow";
import { useSlotJustTaken } from "@/app/explore/experts/[consultantId]/hooks/useSlotJustTaken";
import { CancellationPolicyNote } from "@/components/booking/CancellationPolicyNote";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import { Refusal } from "@/lib/errors/refusal";
import {
  DIRECT_CHECKOUT_HOLD_MS,
  MINIMUM_BOOKING_LEAD_TIME_MINUTES,
  MINIMUM_BOOKING_LEAD_TIME_MS,
} from "@/lib/payments/constants";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";
import {
  consultationSearchParamsSchema,
  type ConsultationSearchParams,
} from "@/schemas/checkout";

import type { ConsultantProfile, ConsultationPlan } from "@prisma/client";

import {
  CheckoutDetailRow,
  type CheckoutPlanAdapter,
  type CheckoutSearchParams,
} from "../components/PlanCheckoutShell";
import { CheckoutTotalNotes } from "../components/CheckoutTotals";
import { reportPaymentsError, type CheckoutApiError } from "../utils";
import { loadErrorMessage, planIncludes, searchParamsKey } from "./shared";

// price arrives as number: extended client + JSON serialization
type ConsultationPlanWithConsultant = Omit<ConsultationPlan, "price"> & {
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

type ConsultationResponse = {
  data: ConsultationPlanWithConsultant;
};

const TIME_NOT_PICKED = () =>
  new Refusal({
    code: "TIME_NOT_PICKED",
    httpStatus: 422,
    userMessage:
      "Pick a time on the expert's profile — under the plan you want — before checking out.",
  });

// Lifted out of the checkout handler to keep its cognitive complexity down: it
// reads which of the three gatewayless confirmations happened.
function gatewaylessConfirmationText(data: {
  isZeroAmountPayment?: boolean;
  isMockPayment?: boolean;
}): string {
  if (data.isZeroAmountPayment) {
    return "Nothing to pay. Your consultation has been confirmed.";
  }
  if (data.isMockPayment) {
    return "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details.";
  }
  return "Your consultation has been confirmed. Check your dashboard for details.";
}

// localStorage, so a second tab sees the buyer's own hold too; it can throw in privacy modes, and a
// lost marker only re-runs the advisory slot check. The marker holds the hold's expiry.
function holdMarkerLive(key: string): boolean {
  try {
    return Number(globalThis.localStorage?.getItem(key)) > Date.now();
  } catch {
    return false;
  }
}

function writeHoldMarker(key: string): void {
  try {
    globalThis.localStorage?.setItem(
      key,
      String(Date.now() + DIRECT_CHECKOUT_HOLD_MS),
    );
  } catch {
    // Advisory only: checkout's own recheck still arbitrates the slot.
  }
}

/** A programme-licence payer is told coverage is verified at checkout. */
function LicenseCoverageNote({
  organizationId,
}: Readonly<{ organizationId: string | null }>) {
  const { data: session } = useSession();
  const fundingSource = useMemo(() => {
    if (!organizationId) return null;
    const memberships = session?.user?.organizationMemberships ?? [];
    return (
      memberships.find((m) => m.organizationId === organizationId)
        ?.fundingSource ?? null
    );
  }, [organizationId, session?.user?.organizationMemberships]);
  if (fundingSource !== "LICENSE") return null;
  return (
    <p className="text-xs text-emerald-600">
      Programme license coverage (if entitled) is verified and applied at
      checkout
    </p>
  );
}

export function useConsultationCheckout(
  planId: string,
  searchParams: CheckoutSearchParams,
): CheckoutPlanAdapter {
  const { toast } = useToast();
  const viewer = useViewerZone();
  const [slotPassedError, setSlotPassedError] = useState<string | null>(null);

  const validatedSearchParams = useMemo((): ConsultationSearchParams | null => {
    const result = consultationSearchParamsSchema.safeParse(searchParams);
    return result.success ? result.data : null;
  }, [searchParams]);
  const searchParamsString = useMemo(
    () => searchParamsKey(searchParams),
    [searchParams],
  );

  // ONE cached read for the mount fetches: the plan plus the (display-only) slot detail.
  const checkoutPlanQuery = useQuery({
    queryKey: ["checkout-plan", planId, searchParamsString],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<{
      plan: ConsultationResponse;
      slot: Record<string, unknown> | null;
      slotFailed: boolean;
    }> => {
      if (!validatedSearchParams) throw TIME_NOT_PICKED();

      // The selected slot must not have passed or be too soon.
      const slotStart = new Date(validatedSearchParams.startsAt);
      if (slotStart.getTime() < Date.now() + MINIMUM_BOOKING_LEAD_TIME_MS) {
        throw new Error(
          "The selected time slot is no longer available. It has either passed or starts too soon. Please go back and select a new slot.",
        );
      }

      const { availabilityWindowWeeklyId, availabilityWindowCustomId } =
        searchParams;
      const slotUrl = availabilityWindowWeeklyId
        ? `/api/scheduling/availability/weekly/${availabilityWindowWeeklyId}`
        : availabilityWindowCustomId
          ? `/api/scheduling/availability/custom/${availabilityWindowCustomId}`
          : null;

      const [planRes, slotRes] = await Promise.all([
        fetch(`/api/plans/consultations/${planId}`),
        // A slot failure stays non-blocking: only a fetch-level throw marks
        // slotFailed; a non-OK answer just leaves the slot empty.
        slotUrl ? fetch(slotUrl).catch(() => null) : Promise.resolve(null),
      ]);

      if (!planRes.ok) {
        throw new Error(`HTTP error! status: ${planRes.status}`);
      }
      const data = await planRes.json();
      if (!data.data.consultantProfile?.user) {
        throw new Error("Consultant details not found");
      }

      let slot: Record<string, unknown> | null = null;
      let slotFailed = false;
      if (slotRes) {
        try {
          if (slotRes.ok) {
            const slotJson = await slotRes.json();
            slot = slotJson.data;
          }
        } catch {
          slotFailed = true;
        }
      } else if (slotUrl) {
        slotFailed = true;
      }
      return { plan: data, slot, slotFailed };
    },
  });
  const eventData = checkoutPlanQuery.data?.plan ?? null;
  const consultantDetails = eventData?.data.consultantProfile;
  const userDetails = consultantDetails?.user;
  const consultantProfileId = eventData?.data?.consultantProfile?.id;

  useEffect(() => {
    if (checkoutPlanQuery.error) {
      reportPaymentsError(checkoutPlanQuery.error);
      console.error(
        "[Checkout] Error fetching event data:",
        checkoutPlanQuery.error,
      );
    }
  }, [checkoutPlanQuery.error]);

  // Slot-detail failure stays a non-blocking warning toast.
  useEffect(() => {
    if (checkoutPlanQuery.data?.slotFailed) {
      toast({
        title: "Warning",
        description:
          "Could not load slot details. You may still proceed with checkout.",
        variant: "default",
      });
    }
  }, [checkoutPlanQuery.data?.slotFailed, toast]);

  const slotJustTaken = useSlotJustTaken(consultantProfileId);
  // A taken time sends the buyer back to a refreshed grid; every other refusal toasts in place.
  const onCheckoutRefusal = useCallback(
    (errorData: CheckoutApiError) => {
      if (errorData.code !== ErrorTypes.SLOT_TAKEN) return false;
      slotJustTaken();
      return true;
    },
    [slotJustTaken],
  );

  // The checkout page can be reached from a stale grid, so it re-asks the grid once before Pay.
  // The buyer's own open hold on this window reads as taken there, so any tab of a browser that
  // already started payment skips it until that hold lapses, leaving it to checkout's resume path.
  const holdMarkerKey = `checkout-hold:${planId}:${validatedSearchParams?.startsAt ?? ""}`;
  const slotOfferedQuery = useQuery({
    queryKey: [
      "checkout-slot-offered",
      consultantProfileId,
      validatedSearchParams?.startsAt,
      validatedSearchParams?.endsAt,
    ],
    enabled: !!consultantProfileId && !!validatedSearchParams,
    // Re-asked on every mount, never answered from an earlier visit's cache.
    gcTime: 0,
    refetchOnMount: "always",
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      holdMarkerLive(holdMarkerKey) ||
      !consultantProfileId ||
      !validatedSearchParams
        ? Promise.resolve(true)
        : isSlotStillOffered(
            consultantProfileId,
            new Date(validatedSearchParams.startsAt),
            new Date(validatedSearchParams.endsAt),
          ),
  });
  const slotNoLongerOffered = slotOfferedQuery.data === false;
  useEffect(() => {
    if (slotNoLongerOffered) slotJustTaken();
  }, [slotNoLongerOffered, slotJustTaken]);

  // Periodic staleness check: warn the buyer if their slot is about to expire.
  useEffect(() => {
    if (!validatedSearchParams) return;
    // Once per crossing, not once per minute: a repeating destructive toast
    // buried the payment form at the moment the buyer was told to hurry.
    let warned = false;
    const checkStaleness = () => {
      const minutesUntilSlot =
        (new Date(validatedSearchParams.startsAt).getTime() - Date.now()) /
        (60 * 1000);
      if (minutesUntilSlot <= 0) {
        setSlotPassedError(
          "This time slot has passed. Please go back and select a new available slot.",
        );
      } else if (
        minutesUntilSlot <= MINIMUM_BOOKING_LEAD_TIME_MINUTES &&
        !warned
      ) {
        warned = true;
        toast({
          title: "Slot starting soon",
          description: `Your selected slot starts in ${Math.ceil(minutesUntilSlot)} minute${Math.ceil(minutesUntilSlot) === 1 ? "" : "s"}. Please complete checkout quickly or select a later slot.`,
          variant: "destructive",
        });
      }
    };
    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [validatedSearchParams, toast]);

  const preflight = useCallback(() => {
    if (!validatedSearchParams) throw TIME_NOT_PICKED();
  }, [validatedSearchParams]);

  const beforePay = useCallback(() => {
    writeHoldMarker(holdMarkerKey);
    return true;
  }, [holdMarkerKey]);

  const checkoutPlanFields = useMemo(
    () =>
      validatedSearchParams
        ? {
            appointmentType: "CONSULTATION" as const,
            planId,
            startsAt: validatedSearchParams.startsAt,
            endsAt: validatedSearchParams.endsAt,
            availabilityWindowWeeklyId:
              validatedSearchParams.availabilityWindowWeeklyId,
            availabilityWindowCustomId:
              validatedSearchParams.availabilityWindowCustomId,
            notes: validatedSearchParams.notes,
          }
        : null,
    [validatedSearchParams, planId],
  );

  return {
    appointmentType: "CONSULTATION",
    isLoading: checkoutPlanQuery.isPending,
    error: slotPassedError ?? loadErrorMessage(checkoutPlanQuery.error),
    missingMessage: null,
    consultantProfileId,
    header: {
      user: userDetails,
      headline: consultantDetails?.headline || "Consultant",
      typeLabel: "Consultation",
      title: eventData?.data?.title || "One-on-One Session",
    },
    detailsTitle: "Consultation Details",
    detailRows: (
      <>
        <CheckoutDetailRow label="Date">
          {validatedSearchParams
            ? formatInViewerZone(
                validatedSearchParams.startsAt,
                viewer.zone,
                "EEEE, d MMMM yyyy",
              )
            : "—"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Time">
          {validatedSearchParams
            ? `${formatInViewerZone(validatedSearchParams.startsAt, viewer.zone, "h:mm a")} - ${formatInViewerZone(validatedSearchParams.endsAt, viewer.zone, "h:mm a")} (${zoneLabel(validatedSearchParams.startsAt, viewer.zone)})`
            : "—"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Duration">
          {eventData?.data?.durationInHours || 1} hours
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Language">
          {eventData?.data?.language || "English"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Level">
          {planLevelLabel(eventData?.data?.level)}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Prerequisites">
          {eventData?.data?.prerequisites || "None"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Material Provided">
          {eventData?.data?.materialProvided || "None"}
        </CheckoutDetailRow>
      </>
    ),
    groupDisclosure: false,
    basePricePaise: eventData?.data?.price || 0,
    pricingTitle: "Consultation Pricing",
    feeLabel: "Session Fee",
    includes: planIncludes(eventData?.data?.whatsIncluded, [
      eventData?.data?.recordingEnabled && "Session recording",
    ]),
    renderFooter: (ctx) => (
      <>
        <CheckoutTotalNotes
          totalPaise={ctx.pricing.total}
          organizationId={ctx.selectedOrganizationId}
          taxContextStatus={ctx.taxContext.taxContextStatus}
        />
        <LicenseCoverageNote organizationId={ctx.selectedOrganizationId} />
        {/* The notice ladder, in the buyer's own terms, at the one moment they
            can still act on it. With a chosen slot the note says what
            cancelling this booking returns. */}
        <CancellationPolicyNote
          eventKind="individual"
          eventStartsAt={validatedSearchParams?.startsAt ?? null}
          funding={ctx.purchaseFunding}
          viewerZone={viewer}
          className="border-t border-border pt-3 text-xs text-muted-foreground"
        />
      </>
    ),
    checkoutPlanFields,
    soldOut: false,
    beforePay,
    onCheckoutRefusal,
    paymentErrorsAsRefusals: true,
    mockFlow: {
      kind: "direct",
      successTitle: "✅ Consultation Booked Successfully!",
      confirmation: gatewaylessConfirmationText,
    },
    preflight,
  };
}
