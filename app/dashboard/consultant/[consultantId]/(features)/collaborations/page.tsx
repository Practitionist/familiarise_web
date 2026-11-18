import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";

/** Inbox › Collaborations: invitations to answer, plans you help deliver, and your own plans' teams. */
export default function CollaborationsPage() {
  return (
    <>
      <DashboardHeader
        title="Collaborations"
        description="Invitations to answer, the webinars and classes you help deliver, and the teams on your own"
      />
      <DashboardContent>
        <InvitationsPanel />
      </DashboardContent>
    </>
  );
}
