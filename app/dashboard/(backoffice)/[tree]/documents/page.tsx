import { DocumentsPage } from "@/components/dashboard/shared/DocumentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Document review log, for both trees; see the component. */
export default async function BackofficeDocumentsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("appointments.manage", (await params).tree);
  return <DocumentsPage />;
}
