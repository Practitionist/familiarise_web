"use client";

import { notFound, useParams, useSearchParams } from "next/navigation";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { useOfferingEvent } from "@/components/offerings/editor/load-offering";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

/**
 * Authoring an offering is a page, not a dialog. `?from=<planId>` is the
 * Offerings card's Duplicate (#1527 §7.2): the editor opens prefilled with a
 * copy of that plan, and nothing is saved until the owner saves it.
 */
export default function NewOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as OfferingType;
  const fromId = useSearchParams().get("from");

  if (!OFFERING_MANIFESTS[type]) notFound();

  const source = useOfferingEvent(type, fromId);

  if (fromId && source.isLoading) {
    return (
      <DashboardContent>
        <PlannerSkeleton />
      </DashboardContent>
    );
  }
  if (source.isError) throw source.error;

  return (
    <DashboardContent className="content-flush-bottom flex flex-1 flex-col">
      <DashboardErrorBoundary>
        <OfferingEditorContainer
          type={type}
          consultantId={consultantId}
          duplicateOf={source.data ?? undefined}
        />
      </DashboardErrorBoundary>
    </DashboardContent>
  );
}
