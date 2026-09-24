import { OperatorAppointmentsPage } from "@/components/dashboard/shared/OperatorAppointmentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Platform-wide appointment triage — shared with the staff tree. */
export default async function AdminAppointmentsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("appointments.manage");
  // Platform-wide by design: operators triage every tenant. Stated
  // explicitly so the widest scope on the platform is never a default (#674).
  return <OperatorAppointmentsPage scope={{ kind: "all" }} />;
}
