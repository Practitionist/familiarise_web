/**
 * @arch4-scaffold DPDP ConsentArtifact management page (Issue #681).
 *
 * View and manage DPDP consent records for the org's members. 7-year
 * retention required by the DPDP Act 2023 Rules (notified 13 Nov 2025).
 */

import Link from "next/link";

export default async function ConsentPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">DPDP Consent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Privacy consent artifacts. Tamper-evident, retained 7 years per
          DPDP Act 2023.
        </p>
      </header>

      <div className="rounded-lg border bg-card p-6">
        <h2 className="font-medium">Pending Phase 2b rewrite</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Consent grant, withdrawal, and audit UI is not yet implemented.
          See{" "}
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
