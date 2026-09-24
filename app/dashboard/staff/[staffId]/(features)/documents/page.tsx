import { DocumentsPage } from "@/components/dashboard/shared/DocumentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Document review log — shared with the admin tree; see the component. */
export default async function StaffDocumentsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("appointments.manage");
  return <DocumentsPage />;
}
