"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";
import { CancellationPolicyNote } from "@/components/booking/CancellationPolicyNote";
import { useToast } from "@/hooks/use-toast";
import { eventCapacityFromCount } from "@/lib/events/capacity";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";
import {
  webinarSearchParamsSchema,
  type WebinarSearchParams,
} from "@/schemas/checkout";

import type {
  Appointment,
  AppointmentOccurrence,
  ConsultantProfile,
  Domain,
  SubDomain,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  User,
  Webinar as PrismaWebinar,
  WebinarPlan,
} from "@prisma/client";

import {
  CheckoutDetailRow,
  type CheckoutPlanAdapter,
  type CheckoutSearchParams,
} from "../components/PlanCheckoutShell";
import { CheckoutTotalNotes } from "../components/CheckoutTotals";
import { reportPaymentsError } from "../utils";
import {
  eventMockErrorCopy,
  loadErrorMessage,
  planIncludes,
  planLoadError,
  searchParamsKey,
} from "./shared";

// price arrives as number: extended client + JSON serialization
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
          // Seats taken, host excluded: the public payload carries a count and
          // never who holds the seats.
          _count: { participants: number };
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

/** Seats left moves as others buy: a short stale window, and a re-read on focus. */
export const WEBINAR_SEATS_FRESHNESS = {
  staleTime: 15_000,
  refetchOnWindowFocus: true,
} as const;

function webinarSeats(
  webinar: CheckoutWebinarPlanData["webinars"][number],
  maxParticipants: number,
) {
  return eventCapacityFromCount({
    instance: webinar,
    plan: { maxParticipants },
    taken: webinar.appointment?._count.participants ?? 0,
  });
}

const mockErrorCopy = eventMockErrorCopy({
  noun: "webinar",
  doneTitle: "Unable to Complete Registration",
  linkErrorTitle: "Registration Link Error",
  action: "Register Now",
  incompleteNoun: "registration",
});

export function useWebinarCheckout(
  planId: string,
  searchParams: CheckoutSearchParams,
): CheckoutPlanAdapter {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The session line prints in the viewer's own saved zone, labelled when it
  // had to fall back.
  const viewer = useViewerZone();
  const [staleError, setStaleError] = useState<string | null>(null);

  // Validate search params once with Zod: the single source of truth.
  const validatedSearchParams = useMemo((): WebinarSearchParams | null => {
    const result = webinarSearchParamsSchema.safeParse(searchParams);
    return result.success ? result.data : null;
  }, [searchParams]);

  const searchParamsString = useMemo(
    () => searchParamsKey(searchParams),
    [searchParams],
  );
  const checkoutPlanKey = useMemo(
    () => ["checkout-plan", planId, searchParamsString] as const,
    [planId, searchParamsString],
  );

  // ONE cached read for the mount fetch.
  const checkoutPlanQuery = useQuery({
    queryKey: checkoutPlanKey,
    ...WEBINAR_SEATS_FRESHNESS,
    retry: false,
    queryFn: async (): Promise<PlanResponse> => {
      const response = await fetch(`/api/plans/webinars/${planId}`);
      if (!response.ok) {
        throw planLoadError(response.status);
      }
      const data = await response.json();
      if (!data.data?.consultantProfile?.user) {
        throw new Error("Consultant details not found");
      }
      return data;
    },
  });
  const planData = checkoutPlanQuery.data ?? null;
  const planDetails = planData?.data;
  const consultantDetails = planDetails?.consultantProfile;
  const userDetails = consultantDetails?.user;

  useEffect(() => {
    if (checkoutPlanQuery.error) {
      reportPaymentsError(checkoutPlanQuery.error);
      console.error("Error fetching plan data:", checkoutPlanQuery.error);
    }
  }, [checkoutPlanQuery.error]);

  // The instance being bought, not the plan's first one: ?eventId names it.
  const targetWebinar = validatedSearchParams?.eventId
    ? planDetails?.webinars?.find((w) => w.id === validatedSearchParams.eventId)
    : planDetails?.webinars?.[0];
  const nextSession = targetWebinar?.appointment?.occurrences?.[0];
  // Seats, honestly: an instance override can contradict the plan's capacity.
  const capacity =
    targetWebinar && planDetails
      ? webinarSeats(targetWebinar, planDetails.maxParticipants)
      : null;
  const isSoldOut = capacity?.isFull ?? false;

  // Periodic staleness check: detect if the webinar has ended or been cancelled.
  const eventIdParam =
    typeof searchParams.eventId === "string" ? searchParams.eventId : undefined;
  useEffect(() => {
    if (!planData?.data?.webinars) return;
    const checkStaleness = () => {
      const target = eventIdParam
        ? planData.data.webinars.find((w) => w.id === eventIdParam)
        : planData.data.webinars[0];
      if (!target) return;
      if (target.status === "COMPLETED") {
        setStaleError("This webinar has already ended.");
      } else if (target.status === "CANCELLED") {
        setStaleError("This webinar has been cancelled.");
      } else if (target.appointment?.occurrences?.[0]) {
        const firstSlotEnd = new Date(
          target.appointment.occurrences[
            target.appointment.occurrences.length - 1
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
  }, [planData, eventIdParam]);

  /**
   * Re-check the seat count against the click, not the last render, so a
   * webinar that filled while this tab sat open never takes a payment into a
   * rejection. `no-store` because the plan endpoint is cached for a minute and
   * that stale count is what is being corrected. A failed check does NOT block
   * the sale: the allocation lock on the server is the authority.
   */
  const eventId = validatedSearchParams?.eventId;
  const revalidateSeatsBeforePayment = useCallback(async () => {
    if (!eventId) return true;
    try {
      const response = await fetch(`/api/plans/webinars/${planId}`, {
        cache: "no-store",
      });
      if (!response.ok) return true;
      const fresh: PlanResponse = await response.json();
      const freshWebinar = fresh.data?.webinars?.find((w) => w.id === eventId);
      if (!fresh.data || !freshWebinar) return true;

      // Refresh the cached plan so isSoldOut re-derives behind this click.
      queryClient.setQueryData(checkoutPlanKey, fresh);

      if (webinarSeats(freshWebinar, fresh.data.maxParticipants).isFull) {
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
  }, [planId, eventId, toast, queryClient, checkoutPlanKey]);

  const preflight = useCallback(() => {
    if (!validatedSearchParams) throw new Error("Invalid webinar parameters");
    if (!planData?.data?.id) throw new Error("Webinar plan not found");
    const target = planData.data.webinars?.find(
      (w) => w.id === validatedSearchParams.eventId,
    );
    if (!target) throw new Error("Webinar session not found.");
    if (target.status === "COMPLETED") {
      throw new Error("This webinar has already ended.");
    }
    if (target.status === "CANCELLED") {
      throw new Error("This webinar has been cancelled.");
    }
    // The server holds the real seat gate under the allocation lock; this
    // stops the buyer paying into a rejection.
    if (webinarSeats(target, planData.data.maxParticipants).isFull) {
      throw new Error("This webinar is now full.");
    }
  }, [validatedSearchParams, planData]);

  const checkoutPlanFields = useMemo(
    () =>
      validatedSearchParams && planDetails
        ? {
            appointmentType: "WEBINAR" as const,
            planId: planDetails.id,
            eventId: validatedSearchParams.eventId,
          }
        : null,
    [validatedSearchParams, planDetails],
  );

  const complete = planData && planDetails && consultantDetails && userDetails;

  return {
    appointmentType: "WEBINAR",
    isLoading: checkoutPlanQuery.isPending,
    error: staleError ?? loadErrorMessage(checkoutPlanQuery.error),
    missingMessage: complete
      ? null
      : "Essential webinar data is missing. Please try again later.",
    consultantProfileId: consultantDetails?.id,
    header: {
      user: userDetails,
      headline:
        consultantDetails?.headline ||
        consultantDetails?.domain?.name ||
        "Consultant",
      typeLabel: "Webinar",
      title: planDetails?.title || "Online Session",
    },
    detailsTitle: "Webinar Details",
    detailRows: (
      <>
        {nextSession && (
          <>
            <CheckoutDetailRow label="Date">
              {formatForViewer(
                nextSession.startsAt,
                viewer,
                "EEEE, d MMMM yyyy",
              )}
            </CheckoutDetailRow>
            <CheckoutDetailRow label="Time">
              {formatForViewer(nextSession.startsAt, viewer, "h:mm a")}
              {" - "}
              {formatForViewer(nextSession.endsAt, viewer, "h:mm a")}
            </CheckoutDetailRow>
          </>
        )}
        <CheckoutDetailRow label="Duration">
          {planDetails?.durationInHours || 1} hours
        </CheckoutDetailRow>
        <CheckoutDetailRow
          label="Seats left"
          className={isSoldOut ? "font-medium text-red-600" : undefined}
        >
          {capacity
            ? isSoldOut
              ? "Sold out"
              : `${capacity.remaining} of ${capacity.max}`
            : (planDetails?.maxParticipants ?? "—")}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Language">
          {planDetails?.language || "English"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Level">
          {planLevelLabel(planDetails?.level)}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Prerequisites">
          {planDetails?.prerequisites || "None"}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Material Provided">
          {planDetails?.materialProvided || "None"}
        </CheckoutDetailRow>
      </>
    ),
    groupDisclosure: true,
    basePricePaise: planDetails?.price || 0,
    pricingTitle: "Webinar Pricing",
    feeLabel: "Registration Fee",
    includes: planIncludes(planDetails?.whatsIncluded, [
      planDetails?.recordingEnabled && "Recording access",
      planDetails?.certificateProvided && "Certificate of attendance",
    ]),
    renderFooter: (ctx) => (
      <>
        {/* The host's free-cancellation window. */}
        <FreeCancellationLine
          startsAt={nextSession?.startsAt}
          windowHours={planDetails?.refundWindowHours}
          className="text-xs text-muted-foreground"
        />
        {/* The rule behind that deadline, and the rail the money comes back on. */}
        <CancellationPolicyNote
          eventKind="webinar"
          eventWindowHours={planDetails?.refundWindowHours}
          eventStartsAt={nextSession?.startsAt}
          funding={ctx.purchaseFunding}
          viewerZone={viewer}
          className="border-t border-border pt-3 text-xs text-muted-foreground"
        />
        <CheckoutTotalNotes
          totalPaise={ctx.pricing.total}
          organizationId={ctx.selectedOrganizationId}
          taxContextStatus={ctx.taxContext.taxContextStatus}
        />
      </>
    ),
    checkoutPlanFields,
    soldOut: isSoldOut,
    beforePay: revalidateSeatsBeforePayment,
    mockFlow: { kind: "unified", type: "WEBINAR" },
    preflight,
    describeMockError: mockErrorCopy,
  };
}
