/**
 * PurchaseOrder management page — scaffold until the dashboard UI ships
 * on top of the live /api/organizations/[id]/billing-account/purchase-orders
 * routes. Required field on Contract when Organization.requiresPO=true
 * (India enterprise AP 3-way match).
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";

export default async function PurchaseOrdersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    canSponsor: true,
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

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
        <h2 className="font-medium">PO dashboard UI coming soon</h2>
        <p className="text-sm text-muted-foreground mt-2">
          The API surface at{" "}
          <code>/api/organizations/{orgId}/billing-account/purchase-orders</code>{" "}
          is live. The dashboard UI ships in a follow-up PR. See{" "}
          <Link
            href="https://github.com/Practitionist/familiarise_web/issues/681"
            className="underline text-primary"
          >
            Issue #681
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
