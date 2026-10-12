import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function ConsultantRecordingsRoute({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  return (
    <>
      <DashboardHeader
        title="Recordings"
        description="Recordings of the sessions you host, by booking. Open a booking to manage a recording."
      />
      <DashboardContent>
        <PersonalLibrary
          tree="consultant"
          profileId={consultantId}
          artifact="recordings"
        />
      </DashboardContent>
    </>
  );
}
