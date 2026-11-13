"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";
import { CancellationPolicyNote } from "@/components/booking/CancellationPolicyNote";
import { deriveBatchCards } from "@/lib/booking/batch-cards";
import { sessionsBoughtLabel } from "@/lib/booking/class-enrolment";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";
import { searchParamsSchema, type SearchParams } from "@/schemas/checkout";

import type {
  Appointment,
  AppointmentOccurrence,
  Class as PrismaClass,
  ClassContent,
  ClassPlan,
  ConsultantProfile,
  Domain,
  SubDomain,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  User,
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
  searchParamsKey,
} from "./shared";

// price arrives as number: extended client + JSON serialization
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
  // One wrapper per batch; `_count` is the seats taken, host excluded.
  classes: (PrismaClass & {
    appointment:
      | (Appointment & {
          occurrences: AppointmentOccurrence[];
          _count: { participants: number };
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

const mockErrorCopy = eventMockErrorCopy({
  noun: "class",
  doneTitle: "Unable to Complete Enrollment",
  linkErrorTitle: "Enrollment Link Error",
  action: "Enroll Now",
  incompleteNoun: "enrollment",
});

export function useClassCheckout(
  planId: string,
  searchParams: CheckoutSearchParams,
): CheckoutPlanAdapter {
  const [staleError, setStaleError] = useState<string | null>(null);
  // One zone for the whole page: the batch derivation, the late-join price and
  // the session times must all resolve in the viewer's own saved zone.
  const viewer = useViewerZone();

  const validatedSearchParams = useMemo((): SearchParams | null => {
    const result = searchParamsSchema.safeParse(searchParams);
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
    queryFn: async (): Promise<PlanResponse> => {
      const response = await fetch(`/api/plans/classes/${planId}`);
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
  const planDetails = planData?.data;
  const consultantDetails = planDetails?.consultantProfile;
  const userDetails = consultantDetails?.user;

  useEffect(() => {
    if (checkoutPlanQuery.error) {
      reportPaymentsError(checkoutPlanQuery.error);
      console.error("Error fetching plan data:", checkoutPlanQuery.error);
    }
  }, [checkoutPlanQuery.error]);

  // The batch named by ?eventId= (never silently another one), else the first
  // joinable batch; its card carries the late-join price.
  const eventId = validatedSearchParams?.eventId;
  const batch = useMemo(() => {
    const plan = planData?.data;
    if (!plan) return null;
    const cards = deriveBatchCards(plan, plan.classes, new Date(), {
      timeZone: viewer.zone,
    });
    const pick = eventId
      ? cards.find((c) => c.classId === eventId)
      : cards.find((c) => c.canEnrol);
    return pick?.canEnrol ? pick : null;
  }, [planData, eventId, viewer.zone]);
  const availableClassId = batch?.classId ?? null;
  const batchPricePaise =
    batch?.enrolment.state === "open"
      ? batch.enrolment.basePaise
      : planDetails?.price || 0;

  // Periodic staleness check: all batches closed, or this one no longer open.
  useEffect(() => {
    if (!planData?.data?.classes) return;
    const checkStaleness = () => {
      const hasAvailable = deriveBatchCards(
        planData.data,
        planData.data.classes,
        new Date(),
        { timeZone: viewer.zone },
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
  }, [planData, batch, viewer.zone]);

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

  const preflight = useCallback(() => {
    if (!validatedSearchParams) throw new Error("Invalid class parameters");
    if (!planData?.data?.id) throw new Error("Class plan not found");
    if (!availableClassId) {
      throw new Error(
        "No available class sessions. All sessions may be full, cancelled, or completed.",
      );
    }
  }, [validatedSearchParams, planData, availableClassId]);

  const checkoutPlanFields = useMemo(
    () =>
      availableClassId && planDetails
        ? {
            appointmentType: "CLASS" as const,
            planId: planDetails.id,
            eventId: availableClassId,
          }
        : null,
    [availableClassId, planDetails],
  );

  const complete = planData && planDetails && consultantDetails && userDetails;
  const totalSessions = planDetails?.totalSessions;
  const sessionsPerWeek = planDetails?.sessionsPerWeek || 2;
  const durationInMonths = planDetails?.durationInMonths || 1;

  return {
    appointmentType: "CLASS",
    isLoading: checkoutPlanQuery.isPending,
    error: staleError ?? loadErrorMessage(checkoutPlanQuery.error),
    missingMessage: complete
      ? null
      : "Essential class data is missing. Please try again later.",
    consultantProfileId: consultantDetails?.id,
    header: {
      user: userDetails,
      headline:
        consultantDetails?.headline ||
        consultantDetails?.domain?.name ||
        "Consultant",
      typeLabel: "Class",
      title: planDetails?.title || "Online Class",
    },
    detailsTitle: "Class Details",
    detailRows: (
      <>
        {batch && (
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground">Batch</div>
            <div className="text-right">{batch.label}</div>
          </div>
        )}
        {batch?.enrolment.state === "open" && batch.enrolment.isLateJoin && (
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
            <CheckoutDetailRow label="Your first session">
              {formatForViewer(
                nextClassSession.startsAt,
                viewer,
                "EEEE, d MMMM yyyy",
              )}
            </CheckoutDetailRow>
            <CheckoutDetailRow label="Time">
              {formatForViewer(nextClassSession.startsAt, viewer, "h:mm a")}
              {" - "}
              {formatForViewer(nextClassSession.endsAt, viewer, "h:mm a zzz")}
            </CheckoutDetailRow>
          </>
        )}
        <CheckoutDetailRow label="Duration">
          {planDetails?.durationInMonths} month
          {planDetails?.durationInMonths !== 1 ? "s" : ""} (
          {totalSessions || (planDetails?.durationInMonths ?? 0) * 4} sessions)
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Sessions per Week">
          {sessionsPerWeek}
        </CheckoutDetailRow>
        <CheckoutDetailRow label="Max Participants">
          {planDetails?.maxParticipants || "Unlimited"}
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
    basePricePaise: batchPricePaise,
    pricingTitle: "Class Pricing",
    feeLabel: "Enrollment Fee",
    includes: planIncludes(planDetails?.whatsIncluded, [
      `${totalSessions || sessionsPerWeek * durationInMonths * 4} total sessions (${planDetails?.totalHours || sessionsPerWeek * durationInMonths * 4} hours)`,
      `${sessionsPerWeek} sessions per week`,
      planDetails?.materialProvided &&
        planDetails.materialProvided !== "None" &&
        "Course materials",
      planDetails?.recordingEnabled && "Session recordings",
      planDetails?.certificateProvided && "Certificate of completion",
    ]),
    renderFooter: (ctx) => (
      <>
        {/* The host's free-cancellation window. */}
        <FreeCancellationLine
          startsAt={nextClassSession?.startsAt}
          windowHours={planDetails?.refundWindowHours}
          kind="class"
          className="text-xs text-muted-foreground"
        />
        {/* The deadline is the line above; this is the rule behind it and the rail the money returns on. */}
        <CancellationPolicyNote
          eventKind="class"
          eventWindowHours={planDetails?.refundWindowHours}
          eventStartsAt={nextClassSession?.startsAt}
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
    soldOut: false,
    mockFlow: { kind: "unified", type: "CLASS" },
    preflight,
    describeMockError: mockErrorCopy,
  };
}
