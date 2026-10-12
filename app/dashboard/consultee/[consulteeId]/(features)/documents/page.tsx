import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function ConsulteeDocumentsRoute({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  await requirePersonalProfileAccess("consultee", consulteeId);
  return (
    <>
      <DashboardHeader
        title="Session documents"
        description="Files you shared with your experts, their replies, and plan materials. Open a booking to upload or ask for changes."
      />
      <DashboardContent>
        <PersonalLibrary
          tree="consultee"
          profileId={consulteeId}
          artifact="documents"
        />
      </DashboardContent>
    </>
  );
}
