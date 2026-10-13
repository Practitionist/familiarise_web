"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText } from "lucide-react";
import { z } from "zod";

import { EmptyState } from "@/components/dashboard/EmptyState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { MaterialsManager } from "@/components/offerings/editor/MaterialsManager";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useListParams } from "@/hooks/useListParams";
import { formatFileSize } from "@/lib/documents/document-utils";
import { getMaterialViewerUrl } from "@/lib/documents/urls";
import type { MaterialPlanType } from "@/lib/plans/material-plan-ref";
import { humanizeEnum } from "@/lib/ui/tone";

export interface OrgMaterialRow {
  id: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  description: string | null;
  uploadedAt: Date;
  planId: string | null;
  planTitle: string | null;
  planType: MaterialPlanType;
}

export interface OrgPlanOption {
  id: string;
  title: string;
  planType: MaterialPlanType;
}

const PlanKindSchema = z.enum([
  "consultation",
  "subscription",
  "webinar",
  "class",
]);

const columns: ResponsiveColumn<OrgMaterialRow>[] = [
  {
    key: "file",
    header: "File",
    primary: true,
    className: "max-w-[280px]",
    cell: (m) => (
      <a
        href={getMaterialViewerUrl(m.id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1 truncate font-medium underline-offset-4 hover:underline"
      >
        <span className="truncate">{m.originalName}</span>
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    ),
  },
  {
    key: "plan",
    header: "Plan",
    className: "max-w-[200px] truncate",
    cell: (m) => m.planTitle ?? "—",
  },
  {
    key: "type",
    header: "Type",
    className: "text-muted-foreground",
    cell: (m) => humanizeEnum(m.planType),
  },
  {
    key: "size",
    header: "Size",
    className: "text-muted-foreground tabular-nums",
    cell: (m) => formatFileSize(m.fileSize),
  },
  {
    key: "uploaded",
    header: "Uploaded",
    className: "text-muted-foreground",
    // Explicit TZ — server (UTC) and browser must agree or hydration
    // mismatches flash the wrong day.
    cell: (m) =>
      new Date(m.uploadedAt).toLocaleDateString("en-IN", {
        timeZone: "UTC",
        dateStyle: "medium",
      }),
  },
];

/**
 * Catalog › Materials: every file on this organization's plans. Choose a plan
 * to add, rename, reorder, replace or delete its files; the page itself is
 * gated to the roles that manage org plan materials.
 */
export function MaterialsPanel({
  items,
  total,
  plans,
}: Readonly<{
  items: OrgMaterialRow[];
  total: number;
  plans: OrgPlanOption[];
}>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useListParams({ filterKeys: ["planId"] as const });
  const selected = plans.find((p) => p.id === list.filters.planId) ?? null;
  const kind = selected
    ? PlanKindSchema.safeParse(selected.planType.toLowerCase())
    : null;

  return (
    <div className="space-y-4">
      <FilterBar
        selects={[
          {
            key: "planId",
            label: "Plan",
            value: selected?.id ?? "all",
            options: [
              { value: "all", label: "Every plan" },
              ...plans.map((p) => ({
                value: p.id,
                label: `${p.title} (${humanizeEnum(p.planType)})`,
              })),
            ],
            onChange: (v) => list.setFilter("planId", v === "all" ? null : v),
          },
        ]}
      />
      {selected && kind?.success ? (
        <MaterialsManager
          kind={kind.data}
          planId={selected.id}
          onChanged={() => {
            void queryClient.invalidateQueries({
              queryKey: ["offering-materials"],
            });
            router.refresh();
          }}
        />
      ) : (
        <>
          <ResponsiveTable<OrgMaterialRow>
            columns={columns}
            rows={items}
            getRowId={(m) => m.id}
            empty={
              <EmptyState
                icon={FileText}
                title="No materials yet"
                description="Choose a plan above to add its first files."
              />
            }
          />
          {items.length < total && (
            <p className="text-xs text-muted-foreground">
              Showing the newest {items.length} of {total} materials.
            </p>
          )}
        </>
      )}
    </div>
  );
}
