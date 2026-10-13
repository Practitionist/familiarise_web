import { DocumentsWorkspacePage } from "@/components/documents/workspace/DocumentsWorkspacePage";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

export default async function AppointmentDocumentsPage({
  params,
}: Readonly<{
  params: Promise<{ consulteeId: string; appointmentId: string }>;
}>) {
  const { consulteeId, appointmentId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  return (
    <DocumentsWorkspacePage
      appointmentId={appointmentId}
      userId={access.userId}
      backHref={`/dashboard/consultee/${consulteeId}/appointments/${appointmentId}`}
      role="learner"
    />
  );
}
