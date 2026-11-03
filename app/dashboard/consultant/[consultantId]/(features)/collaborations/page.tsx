"use client";

import { useParams } from "next/navigation";

import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import { SellPageShell } from "@/components/offerings/list/SellPageShell";

/** Sell › Collaborations: invitations and the plans you co-host. */
export default function CollaborationsPage() {
  const { consultantId } = useParams<{ consultantId: string }>();
  return (
    <SellPageShell
      consultantId={consultantId}
      title="Collaborations"
      description="Invitations to co-host, and the webinars and classes you deliver with others"
    >
      <InvitationsPanel />
    </SellPageShell>
  );
}
