"use client";

import { notFound, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import {
  useConsultationPlans,
  useSubscriptionPlans,
} from "@/components/planner/hooks/usePlanner";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

/**
 * The editor's adapters read the plan out of a planner event wrapper, so the
 * flat rows /api/plans/* returns are wrapped exactly as the planner list wraps
 * them (EventManagementDashboard). The wrapper's id is the plan id, which is
 * also what the planner's Edit button puts in the URL.
 */
function toPlanEvents(
  type: "consultation" | "subscription",
  plans: Array<{ id: string }> | undefined,
) {
  const planKey =
    type === "consultation" ? "consultationPlan" : "subscriptionPlan";
  return (plans ?? []).map((plan) => ({ type, id: plan.id, [planKey]: plan }));
}

/**
 * The row being edited comes from whichever query owns that offering type. The
 * planner payload carries webinars and classes ONLY, so consultation and
 * subscription are read from the same /api/plans/* endpoints the planner list
 * uses — sourcing all four from the planner made those two 404 every time.
 *
 * Only the query the requested type needs runs; the other two stay disabled.
 */
export default function EditOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as OfferingType;
  const offeringId = params.offeringId as string;

  const plannerQuery = createConsultantQueries(consultantId).planner;
  const planner = useQuery({
    ...plannerQuery,
    enabled: type === "webinar" || type === "class",
  });
  const consultations = useConsultationPlans(consultantId, {
    enabled: type === "consultation",
  });
  const subscriptions = useSubscriptionPlans(consultantId, {
    enabled: type === "subscription",
  });

  if (!OFFERING_MANIFESTS[type]) notFound();

  // notFound() must stay unreachable while a source is still in flight, or the
  // editor 404s on a row that was about to arrive. A disabled query reports
  // isLoading false, so this gate only waits on the one that is running.
  if (planner.isLoading || consultations.isLoading || subscriptions.isLoading) {
    return (
      <>
        <DashboardHeader title="Edit offering" />
        <DashboardContent>
          <PlannerSkeleton />
        </DashboardContent>
      </>
    );
  }

  let events: unknown[];
  if (type === "consultation") {
    events = toPlanEvents("consultation", consultations.data);
  } else if (type === "subscription") {
    events = toPlanEvents("subscription", subscriptions.data);
  } else {
    events = [
      ...(planner.data?.webinars ?? []),
      ...(planner.data?.classes ?? []),
    ];
  }

  const initialEvent = events.find(
    (event) => (event as { id?: string })?.id === offeringId,
  );

  if (!initialEvent) notFound();

  return (
    <>
      <DashboardHeader
        title={`Edit ${OFFERING_MANIFESTS[type].noun}`}
        subtitle="Changes go live when you save."
      />
      <DashboardContent>
        <DashboardErrorBoundary>
          <OfferingEditorContainer
            type={type}
            consultantId={consultantId}
            initialEvent={initialEvent}
          />
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
