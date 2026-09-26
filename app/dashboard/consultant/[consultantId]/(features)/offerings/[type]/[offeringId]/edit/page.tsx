"use client";

import { notFound, useParams, useSearchParams } from "next/navigation";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { useOfferingEvent } from "@/components/offerings/editor/load-offering";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

export default function EditOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as OfferingType;
  const offeringId = params.offeringId as string;
  // A group card names its batch, so the save lands on that Class/Webinar row.
  const instanceId = useSearchParams().get("instance");

  if (!OFFERING_MANIFESTS[type]) notFound();

  const offering = useOfferingEvent(type, offeringId, instanceId);

  if (offering.isLoading) {
    return (
      <>
        <DashboardHeader title="Edit offering" />
        <DashboardContent>
          <PlannerSkeleton />
        </DashboardContent>
      </>
    );
  }

  // Query failures are real errors (network / 500), not missing rows — let the
  // dashboard error boundary render them instead of pretending the plan is gone.
  if (offering.isError) throw offering.error;

  if (!offering.data) notFound();

  return (
    <DashboardContent className="content-flush-bottom flex flex-1 flex-col">
      <DashboardErrorBoundary>
        <OfferingEditorContainer
          type={type}
          consultantId={consultantId}
          initialEvent={offering.data}
        />
      </DashboardErrorBoundary>
    </DashboardContent>
  );
}
