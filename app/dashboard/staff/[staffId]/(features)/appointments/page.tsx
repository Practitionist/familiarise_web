import { OperatorAppointmentsPage } from "@/components/dashboard/shared/OperatorAppointmentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";
import { AppointmentsWithOps } from "@/components/dashboard/backoffice/money/AppointmentsWithOps";

/** Platform-wide appointment triage — shared with the admin tree. */
export default async function StaffAppointmentsPage({
  params,
}: Readonly<{ params: Promise<{ staffId: string }> }>) {
  const { staffId } = await params;
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("appointments.manage");
  // Platform-wide by design: operators triage every tenant. Stated
  // explicitly so the widest scope on the platform is never a default (#674).
  return (
    <OperatorAppointmentsPage scope={{ kind: "all" }}>
      <AppointmentsWithOps
        tree="staff"
        treePath={`/dashboard/staff/${staffId}`}
      />
    </OperatorAppointmentsPage>
  );
}
