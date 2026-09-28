"use client";

import { useParams } from "next/navigation";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import { NewOfferingMenu } from "@/components/offerings/list/NewOfferingMenu";
import { OfferingsTabs } from "@/components/offerings/list/OfferingsTabs";

/** #1527 §13b — Offerings · Collaborations: invitations and co-hosted events. */
export default function OfferingsCollaborationsPage() {
  const consultantId = useParams().consultantId as string;
  return (
    <>
      <DashboardHeader
        title="Offerings"
        description="What you sell, and the webinars and classes you deliver with others"
        actions={<NewOfferingMenu consultantId={consultantId} />}
      />
      <OfferingsTabs consultantId={consultantId} />
      <DashboardContent>
        <InvitationsPanel />
      </DashboardContent>
    </>
  );
}
