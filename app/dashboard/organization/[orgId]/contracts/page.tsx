/**
 * @arch4-scaffold Contract management page (Issue #681).
 *
 * List, create, and terminate Contracts for the current org. Each Contract
 * links the org to a BillingAccount and one or more Programs. Full CRUD
 * lands in the Phase 2b follow-up PR.
 */

import Link from "next/link";

export default async function ContractsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
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
        <h2 className="font-medium">Pending Phase 2b rewrite</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Contract CRUD UI is not yet implemented. See{" "}
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
