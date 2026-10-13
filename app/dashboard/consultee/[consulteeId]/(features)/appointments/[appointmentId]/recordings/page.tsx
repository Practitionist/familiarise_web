import { RecordingSessionsPage } from "@/components/recordings/RecordingSessionsPage";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function AppointmentRecordingsPage({
  params,
}: Readonly<{
  params: Promise<{ consulteeId: string; appointmentId: string }>;
}>) {
  const { consulteeId, appointmentId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  return (
    <RecordingSessionsPage
      appointmentId={appointmentId}
      userId={access.userId}
      backHref={`/dashboard/consultee/${consulteeId}/appointments/${appointmentId}`}
      role="learner"
    />
  );
}
