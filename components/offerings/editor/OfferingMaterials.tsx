"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import type { OfferingType } from "./manifest";

const PLURAL: Record<OfferingType, string> = {
  consultation: "consultations",
  subscription: "subscriptions",
  webinar: "webinars",
  class: "classes",
};

interface MaterialRow {
  id: string;
  originalName: string;
  fileSize: number;
}

/** Mirrors OrgMaterialChange in app/api/plans/shared/materials-handler.ts. */
interface Change {
  action: "added" | "updated" | "removed";
  materialId: string | null;
  fileName: string | null;
  orgName: string;
  actorName: string | null;
  at: string;
}

interface MaterialsResponse {
  data: MaterialRow[];
  // Present only for the plan's own consultant (#1851 decision 8).
  orgChanges?: Change[];
}

/** "Changed by Acme · Priya · 3 Oct 2026" — the org's trail on one file. */
function changeLine(change: Change): string {
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

/**
 * Offering › Materials: the files attached to this plan. On an org-owned plan
 * the org's catalog roles may add, replace or remove files (#1851 decision 8),
 * so each file the org touched carries a "Changed by" line, and a file the org
 * removed stays listed as removed. The changes come from the org's audit log,
 * which the materials API returns only to the plan's own consultant.
 */
export function OfferingMaterials({
  type,
  planId,
}: Readonly<{ type: OfferingType; planId: string }>) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["offering-materials", type, planId],
    queryFn: async (): Promise<MaterialsResponse> => {
      const res = await fetch(`/api/plans/${PLURAL[type]}/${planId}/materials`);
      if (!res.ok) throw new Error("Couldn't load materials");
      return res.json();
    },
  });

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading materials…</p>;
  }
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load the materials for this offering.
      </p>
    );
  }

  // Newest first from the API, so the first change per file is its latest.
  const latest = new Map<string, Change>();
  for (const change of data.orgChanges ?? []) {
    if (change.materialId && !latest.has(change.materialId)) {
      latest.set(change.materialId, change);
    }
  }
  const live = new Set(data.data.map((m) => m.id));
  const removed = [...latest.values()].filter(
    (c) => c.action === "removed" && c.materialId && !live.has(c.materialId),
  );

  if (data.data.length === 0 && removed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No materials are attached to this offering.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {data.data.map((m) => {
        const change = latest.get(m.id);
        return (
          <li key={m.id} className="flex items-start gap-3 p-3 text-sm">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate font-medium">{m.originalName}</p>
              <p className="text-xs text-muted-foreground">
                {(m.fileSize / (1024 * 1024)).toFixed(1)} MB
              </p>
              {change && (
                <p className="text-xs text-muted-foreground">
                  {changeLine(change)}
                </p>
              )}
            </div>
          </li>
        );
      })}
      {removed.map((c) => (
        <li key={`removed-${c.materialId}`} className="flex items-start gap-3 p-3 text-sm">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
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
}
