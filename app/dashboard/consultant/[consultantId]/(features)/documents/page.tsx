import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function ConsultantDocumentsRoute({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  return (
    <>
      <DashboardHeader
        title="Session documents"
        description="Your learners' files and your replies, by booking. Open a booking to review."
      />
      <DashboardContent>
        <PersonalLibrary
          tree="consultant"
          profileId={consultantId}
          artifact="documents"
        />
      </DashboardContent>
    </>
  );
}
