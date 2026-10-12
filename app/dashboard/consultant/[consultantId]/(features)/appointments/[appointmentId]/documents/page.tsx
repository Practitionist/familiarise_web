import { DocumentsWorkspacePage } from "@/components/documents/workspace/DocumentsWorkspacePage";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function AppointmentDocumentsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string; appointmentId: string }>;
}>) {
  const { consultantId, appointmentId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  return (
    <DocumentsWorkspacePage
      appointmentId={appointmentId}
      userId={access.userId}
      backHref={`/dashboard/consultant/${consultantId}/appointments/${appointmentId}`}
      role="expert"
    />
  );
}
