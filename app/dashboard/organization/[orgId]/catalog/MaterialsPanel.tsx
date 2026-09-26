"use client";

import { FileText } from "lucide-react";

import { EmptyState } from "@/components/dashboard/EmptyState";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { humanizeEnum } from "@/lib/ui/tone";

export interface OrgMaterialRow {
  id: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  description: string | null;
  uploadedAt: Date;
  planTitle: string | null;
  planType: string;
}

const columns: ResponsiveColumn<OrgMaterialRow>[] = [
  {
    key: "file",
    header: "File",
    primary: true,
    className: "max-w-[280px] truncate font-medium",
    cell: (m) => m.originalName,
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
    cell: (m) => `${(m.fileSize / (1024 * 1024)).toFixed(1)} MB`,
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
 * Catalog › Materials (#1527-4d): handouts attached to this org's plans. A
 * read-only metadata inventory (ADR 20); content reaches members through
 * their sessions and is managed in the plan editor.
 */
export function MaterialsPanel({
  items,
  total,
}: Readonly<{ items: OrgMaterialRow[]; total: number }>) {
  return (
    <>
      <ResponsiveTable<OrgMaterialRow>
        columns={columns}
        rows={items}
        getRowId={(m) => m.id}
        empty={
          <EmptyState
            icon={FileText}
            title="No materials yet"
            description="Handouts attached to this organization's plans appear here."
          />
        }
      />
      {items.length < total && (
        <p className="text-xs text-muted-foreground">
          Showing the newest {items.length} of {total} materials.
        </p>
      )}
    </>
  );
}
