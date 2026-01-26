"use client";

import { InvoicesPage } from "@/components/dashboard/shared/InvoicesPage";

export default function AdminInvoicesPage() {
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
