/**
 * Contract management page — scaffold until the dashboard CRUD UI
 * ships on top of the live /api/organizations/[id]/contracts routes.
 * Gated here at the server so a direct URL bypass still can't render
 * the placeholder on a host-only org.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";

export default async function ContractsPage({
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
        <h1 className="text-2xl font-semibold">Contracts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Commercial agreements between your organization and Familiarise.
          Each contract governs its own Programs and billing terms.
        </p>
      </header>

      <div className="rounded-lg border bg-card p-6">
        <h2 className="font-medium">Contract CRUD UI coming soon</h2>
        <p className="text-sm text-muted-foreground mt-2">
          The API surface at <code>/api/organizations/{orgId}/contracts</code>{" "}
          is live. The dashboard CRUD UI that reads it ships in a follow-up
          PR. See{" "}
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
