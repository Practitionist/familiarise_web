"use client";

import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";

/** Inbox › Collaborations: invitations and the plans you co-host. */
export default function CollaborationsPage() {
  return (
    <>
      <DashboardHeader
        title="Collaborations"
        description="Invitations to co-host, and the webinars and classes you deliver with others"
      />
      <DashboardContent>
        <InvitationsPanel />
      </DashboardContent>
    </>
  );
}
