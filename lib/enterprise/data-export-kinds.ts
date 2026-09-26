import type { MemberRole, Prisma } from "@prisma/client";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

/**
 * #1527 decision 4 — DPDP §11 bundles are split by kind so each role exports
 * only what its dashboard already shows: the people bundle (members, the
 * consent-withheld count, the audit trail) is GOVERNANCE's; the finance
 * bundle (contracts, programs, invoices, earnings, payouts) is OWNER +
 * BILLING_ADMIN's.
 *
 * `OrgDataExportJob` has no kind column (adding one is a schema change), so
 * the kind rides on the job's DATA_EXPORT_REQUESTED audit row, written in the
 * same transaction as the job. A job whose row carries no kind predates the
 * split and is treated as a full bundle: only a holder of every kind may see
 * or download it.
 */
export const DATA_EXPORT_KINDS = ["people", "finance"] as const;
export type DataExportKind = (typeof DATA_EXPORT_KINDS)[number];

const KIND_GRANT: Record<DataExportKind, OrgSurface> = {
  people: "dataExports.people",
  finance: "dataExports.finance",
};

export function dataExportKindsFor(role: MemberRole): DataExportKind[] {
  return DATA_EXPORT_KINDS.filter((kind) =>
    hasOrgPermission(role, KIND_GRANT[kind]),
  );
}

/** `null` = a pre-split job (full bundle). */
export function canHandleExportKind(
  role: MemberRole,
  kind: DataExportKind | null,
): boolean {
  const held = dataExportKindsFor(role);
  return kind === null
    ? held.length === DATA_EXPORT_KINDS.length
    : held.includes(kind);
}

/** Reads the kind off a DATA_EXPORT_REQUESTED row's `details`. */
export function exportKindFromDetails(
  details: Prisma.JsonValue | null,
): DataExportKind | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const kind = (details as Record<string, unknown>).kind;
  return DATA_EXPORT_KINDS.find((k) => k === kind) ?? null;
}
