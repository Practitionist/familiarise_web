import { RecordingSessionsPage } from "@/components/recordings/RecordingSessionsPage";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function AppointmentRecordingsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string; appointmentId: string }>;
}>) {
  const { consultantId, appointmentId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  return (
    <RecordingSessionsPage
      appointmentId={appointmentId}
      userId={access.userId}
      backHref={`/dashboard/consultant/${consultantId}/appointments/${appointmentId}`}
      role="host"
    />
  );
}
