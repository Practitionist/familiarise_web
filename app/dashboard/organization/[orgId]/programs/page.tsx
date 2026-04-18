/**
 * @arch4-scaffold Program management page (Issue #681).
 *
 * List, create, and assign Programs (LICENSED_SEAT, CREDIT_POOL) to
 * Memberships within the current org. v2 adds PROJECT and RETAINER types.
 */

import Link from "next/link";

export default async function ProgramsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Programs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Typed commercial offerings attached to a Contract. Each Program
          controls what&apos;s covered per assigned member.
        </p>
      </header>

      <div className="rounded-lg border bg-card p-6">
        <h2 className="font-medium">Pending Phase 2b rewrite</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Program CRUD + assignment UI is not yet implemented. v1 supports
          two program types:
        </p>
        <ul className="text-sm list-disc list-inside mt-3 space-y-1 text-muted-foreground">
          <li>
            <strong>LICENSED_SEAT</strong> — BetterUp/CoachHub per-seat annual
            license with implicit session allotment.
          </li>
          <li>
            <strong>CREDIT_POOL</strong> — GLG/Guidepoint wallet-backed credit
            pool; each booking debits from a shared pool.
          </li>
        </ul>
        <p className="text-xs text-muted-foreground mt-4">
          See{" "}
          <Link
            href="https://github.com/Practitionist/familiarise_web/issues/681"
            className="underline text-primary"
          >
            Issue #681
          </Link>{" "}
          — Organization ID: <code>{orgId}</code>
        </p>
      </div>
    </div>
  );
}
