import { InvoicesPage } from "@/components/dashboard/shared/InvoicesPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeInvoicesPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  const { tree } = await params;
  await requireBackofficePage("invoices.read", tree);
  return (
    <InvoicesPage
      apiEndpoint="/api/admin/invoices"
      title="Invoices"
      description="View all platform payment invoices"
      dashboardBasePath={`/dashboard/${tree}`}
      queryKeyPrefix="admin-invoices"
    />
  );
}
