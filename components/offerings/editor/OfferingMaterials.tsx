"use client";

import { FileText } from "lucide-react";

import type { MaterialPlanKind } from "@/lib/plans/material-client";
import { MaterialsManager, type OrgMaterialChange } from "./MaterialsManager";

/** "Changed by Acme · Priya · 3 Oct 2026" — the org's trail on one file. */
function changeLine(change: OrgMaterialChange): string {
  const when = new Date(change.at).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return [`Changed by ${change.orgName}`, change.actorName, when]
    .filter(Boolean)
    .join(" · ");
}

/** The newest change per material; the API returns newest first. */
function latestByMaterial(changes: OrgMaterialChange[]) {
  const latest = new Map<string, OrgMaterialChange>();
  for (const change of changes) {
    if (change.materialId && !latest.has(change.materialId)) {
      latest.set(change.materialId, change);
    }
  }
  return latest;
}

/**
 * Offering › Materials: manage the files attached to this plan. On an
 * org-owned plan the org's catalog roles may change files too, so each file
 * the org touched carries a "Changed by" line and an org-removed file stays
 * listed as removed (the trail is returned only to the plan's own expert).
 */
export function OfferingMaterials({
  type,
  planId,
}: Readonly<{ type: MaterialPlanKind; planId: string }>) {
  return (
    <MaterialsManager
      kind={type}
      planId={planId}
      annotate={(materialId, changes) => {
        const change = latestByMaterial(changes).get(materialId);
        return change ? (
          <p className="text-xs text-muted-foreground">{changeLine(change)}</p>
        ) : null;
      }}
      footer={(changes, liveIds) => {
        const removed = [...latestByMaterial(changes).values()].filter(
          (c) =>
            c.action === "removed" &&
            c.materialId &&
            !liveIds.has(c.materialId),
        );
        if (removed.length === 0) return null;
        return (
          <ul className="divide-y rounded-md border">
            {removed.map((c) => (
              <li
                key={`removed-${c.materialId}`}
                className="flex items-start gap-3 p-3 text-sm"
              >
                <FileText
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="truncate text-muted-foreground line-through">
                    {c.fileName ?? "A file"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Removed. {changeLine(c)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        );
      }}
    />
  );
}
