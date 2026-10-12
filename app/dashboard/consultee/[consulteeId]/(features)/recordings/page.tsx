import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function ConsulteeRecordingsRoute({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  await requirePersonalProfileAccess("consultee", consulteeId);
  return (
    <>
      <DashboardHeader
        title="Recordings"
        description="Your sessions' recordings, by booking. A session your run missed shows a catch-up from another run."
      />
      <DashboardContent>
        <PersonalLibrary
          tree="consultee"
          profileId={consulteeId}
          artifact="recordings"
        />
      </DashboardContent>
    </>
  );
}
