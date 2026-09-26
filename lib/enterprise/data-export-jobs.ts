import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  exportKindFromDetails,
  type DataExportKind,
} from "@/lib/enterprise/data-export-kinds";

/**
 * Kind of each export job, read from its DATA_EXPORT_REQUESTED audit row
 * (see data-export-kinds.ts for why the audit row carries it). Jobs with no
 * row or no kind map to `null` — a pre-split full bundle.
 */
export async function loadExportKinds(
  organizationId: string,
  exportIds: readonly string[],
): Promise<Map<string, DataExportKind | null>> {
  const kinds = new Map<string, DataExportKind | null>(
    exportIds.map((id) => [id, null]),
  );
  if (exportIds.length === 0) return kinds;
  const rows = await prisma.orgAuditLog.findMany({
    where: {
      organizationId,
      action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_REQUESTED,
      OR: exportIds.map((id) => ({
        details: { path: ["exportId"], equals: id },
      })),
    },
    select: { details: true },
  });
  for (const row of rows) {
    const details = row.details as { exportId?: unknown } | null;
    if (typeof details?.exportId === "string" && kinds.has(details.exportId)) {
      kinds.set(details.exportId, exportKindFromDetails(row.details));
    }
  }
  return kinds;
}
