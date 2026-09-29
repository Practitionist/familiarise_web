import type { MemberRole, OrgDataExportKind } from "@prisma/client";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

/**
 * #1527 decision 4 — DPDP §11 bundles are split by kind so each role exports
 * only what its dashboard already shows: the people bundle (members, the
 * consent-withheld count, the audit trail) is GOVERNANCE's; the finance
 * bundle (contracts, programs, invoices, earnings, payouts) is OWNER +
 * BILLING_ADMIN's.
 *
 * The kind lives on `OrgDataExportJob.kind`. `FULL` marks a job from before
 * the split: it builds both kinds, so only a holder of every kind may see or
 * download it, and nobody can request a new one.
 */
export const DATA_EXPORT_KINDS = [
  "PEOPLE",
  "FINANCE",
] as const satisfies readonly OrgDataExportKind[];
export type DataExportKind = (typeof DATA_EXPORT_KINDS)[number];

const KIND_GRANT: Record<DataExportKind, OrgSurface> = {
  PEOPLE: "dataExports.people",
  FINANCE: "dataExports.finance",
};

export function dataExportKindsFor(role: MemberRole): DataExportKind[] {
  return DATA_EXPORT_KINDS.filter((kind) =>
    hasOrgPermission(role, KIND_GRANT[kind]),
  );
}

/** The kinds a job's bundle carries — FULL expands to every kind. */
export function bundleKinds(kind: OrgDataExportKind): DataExportKind[] {
  return kind === "FULL" ? [...DATA_EXPORT_KINDS] : [kind];
}

export function canHandleExportKind(
  role: MemberRole,
  kind: OrgDataExportKind,
): boolean {
  const held = dataExportKindsFor(role);
  return bundleKinds(kind).every((k) => held.includes(k));
}
