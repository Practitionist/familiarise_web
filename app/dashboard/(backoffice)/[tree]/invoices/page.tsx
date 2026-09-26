import { InvoicesPage } from "@/components/dashboard/shared/InvoicesPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeInvoicesPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("invoices.read", (await params).tree);
  return (
    <InvoicesPage
      apiEndpoint="/api/admin/invoices"
      title="Invoices"
      description="View all platform payment invoices"
      showExport={true}
      queryKeyPrefix="admin-invoices"
    />
  );
}
