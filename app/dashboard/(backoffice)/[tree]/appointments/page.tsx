import { OperatorAppointmentsPage } from "@/components/dashboard/shared/OperatorAppointmentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";
import { AppointmentsWithOps } from "@/components/dashboard/backoffice/money/AppointmentsWithOps";

/** Platform-wide appointment triage, for both trees. */
export default async function BackofficeAppointmentsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("appointments.manage", (await params).tree);
  // Platform-wide by design: operators triage every tenant. Stated
  // explicitly so the widest scope on the platform is never a default (#674).
  return (
    <OperatorAppointmentsPage scope={{ kind: "all" }}>
      <AppointmentsWithOps />
    </OperatorAppointmentsPage>
  );
}
