import { DocumentsPage } from "@/components/dashboard/shared/DocumentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Document review log — shared with the staff tree; see the component. */
export default async function AdminDocumentsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("appointments.manage");
  return <DocumentsPage />;
}
