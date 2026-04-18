/**
 * @arch4-scaffold PurchaseOrder management page (Issue #681).
 *
 * Upload and track PurchaseOrders for this org. Required field on
 * Contract when Organization.requiresPO=true (India enterprise AP).
 */

import Link from "next/link";

export default async function PurchaseOrdersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Purchase Orders</h1>
        <p className="text-sm text-muted-foreground mt-1">
          First-class PO records for India AP 3-way match workflows.
          Invoices reference these; contracts can be PO-backed.
        </p>
      </header>

      <div className="rounded-lg border bg-card p-6">
        <h2 className="font-medium">Pending Phase 2b rewrite</h2>
        <p className="text-sm text-muted-foreground mt-2">
          PO upload and tracking UI is not yet implemented. See{" "}
          <Link
            href="https://github.com/Practitionist/familiarise_web/issues/681"
            className="underline text-primary"
          >
            Issue #681
          </Link>
          .
        </p>
        <p className="text-xs text-muted-foreground mt-4">
          Organization ID: <code>{orgId}</code>
        </p>
      </div>
    </div>
  );
}
