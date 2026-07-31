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
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

/**
 * Editing reuses the planner's own query rather than inventing a per-offering
 * fetch: the planner already loads every offering this consultant owns, so the
 * row is usually in cache and the editor opens without a spinner.
 */
export default function EditOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as OfferingType;
  const offeringId = params.offeringId as string;

  const plannerQuery = createConsultantQueries(consultantId).planner;
  const { data, isLoading } = useQuery(plannerQuery);

  if (!OFFERING_MANIFESTS[type]) notFound();

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="Edit offering" />
        <DashboardContent>
          <PlannerSkeleton />
        </DashboardContent>
      </>
    );
  }

  const events = [
    ...((data as { consultationPlans?: unknown[] })?.consultationPlans ?? []),
    ...((data as { subscriptionPlans?: unknown[] })?.subscriptionPlans ?? []),
    ...((data as { webinars?: unknown[] })?.webinars ?? []),
    ...((data as { classes?: unknown[] })?.classes ?? []),
  ];

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
