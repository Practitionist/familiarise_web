"use client";

import { notFound, useParams, useSearchParams } from "next/navigation";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { DigitalProductEditorContainer } from "@/components/offerings/editor/DigitalProductEditorContainer";
import {
  useDigitalProduct,
  useOfferingEvent,
} from "@/components/offerings/editor/load-offering";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type {
  EditorOfferingType,
  OfferingType,
} from "@/components/offerings/editor/manifest";

function EditorSkeleton() {
  return (
    <>
      <DashboardHeader title="Edit offering" />
      <DashboardContent>
        <PlannerSkeleton />
      </DashboardContent>
    </>
  );
}

export default function EditOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as EditorOfferingType;
  const offeringId = params.offeringId as string;

  if (type === "digital-product") {
    return (
      <EditDigitalProduct consultantId={consultantId} productId={offeringId} />
    );
  }
  if (!OFFERING_MANIFESTS[type]) notFound();
  return (
    <EditPlanOffering
      consultantId={consultantId}
      type={type}
      offeringId={offeringId}
    />
  );
}

function EditDigitalProduct({
  consultantId,
  productId,
}: Readonly<{ consultantId: string; productId: string }>) {
  const product = useDigitalProduct(productId);
  if (product.isLoading) return <EditorSkeleton />;
  if (product.isError) throw product.error;
  if (!product.data) notFound();
  return (
    <DashboardContent className="content-flush-bottom flex flex-1 flex-col">
      <DashboardErrorBoundary>
        <DigitalProductEditorContainer
          consultantId={consultantId}
          product={product.data}
        />
      </DashboardErrorBoundary>
    </DashboardContent>
  );
}

function EditPlanOffering({
  consultantId,
  type,
  offeringId,
}: Readonly<{ consultantId: string; type: OfferingType; offeringId: string }>) {
  // A group card names its batch, so the save lands on that Class/Webinar row.
  const instanceId = useSearchParams().get("instance");

  const offering = useOfferingEvent(type, offeringId, instanceId);

  if (offering.isLoading) return <EditorSkeleton />;

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
