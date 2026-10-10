"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Download,
  ExternalLink,
  Eye,
  FileText,
  FileUp,
  MessageSquare,
  Search,
} from "lucide-react";

import { PageHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DocumentReviewDrawer } from "@/components/documents/DocumentReviewDrawer";
import { useListParams } from "@/hooks/useListParams";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import {
  groupDocumentsIntoThreads,
  type DocumentThread,
} from "@/lib/documents/document-review";
import {
  getAppointmentDocumentUrl,
  getPlanMaterialUrl,
} from "@/lib/documents/urls";
import { formatFileSize } from "@/lib/documents/document-utils";
import type {
  ConsulteeDocumentRow,
  ConsulteeDocumentsPayload,
  ConsulteeMaterialRow,
} from "@/lib/data/consultee-documents";

const PAGE_SIZE = 20;

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const STATUS_CHIPS = [
  { value: "", label: "All" },
  { value: "NEEDS_REVISION", label: "Needs revision" },
  { value: "IN_REVIEW", label: "In review" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
] as const;

async function fetchDocuments(
  consulteeId: string,
  page: number,
  statusFilter: string,
): Promise<ConsulteeDocumentsPayload> {
  const offset = (page - 1) * PAGE_SIZE;
  const qs = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (statusFilter) {
    qs.set("status", statusFilter);
  }
  const res = await fetch(
    `/api/dashboard/consultee/${consulteeId}/documents?${qs.toString()}`,
  );
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function buildThreadColumns(
  basePath: string,
  onOpenDrawer: (rootId: string) => void,
): ResponsiveColumn<DocumentThread<ConsulteeDocumentRow>>[] {
  return [
    {
      key: "deliverable",
      header: "Deliverable",
      primary: true,
      cell: (thread) => (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpenDrawer(thread.rootId)}
              className="inline-flex items-center gap-1.5 text-left font-medium text-foreground underline-offset-4 hover:underline"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{thread.title}</span>
            </button>
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              v{thread.latestVersion.versionNo ?? thread.versionCount}
            </Badge>
            {thread.versionCount > 1 && (
              <span className="text-[11px] text-muted-foreground">
                ({thread.versionCount} versions)
              </span>
            )}
          </div>
          {thread.effectiveReviewNotes && (
            <p className="inline-flex max-w-md items-start gap-1 text-xs text-muted-foreground">
              <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
              <span className="line-clamp-1">
                {thread.effectiveReviewNotes}
              </span>
            </p>
          )}
        </div>
      ),
    },
    {
      key: "booking",
      header: "Session / Offering",
      cell: (thread) => (
        <div className="space-y-0.5">
          <Link
            href={`${basePath}/appointments/${thread.appointmentId}`}
            className="block font-medium text-foreground underline-offset-4 hover:underline"
          >
            {thread.latestVersion.appointmentTitle}
          </Link>
          {thread.latestVersion.consultantName && (
            <span className="block text-xs text-muted-foreground">
              with {thread.latestVersion.consultantName}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (thread) => (
        <StatusBadge
          {...documentReviewStatusBadge(thread.effectiveStatus)}
          size="sm"
        />
      ),
    },
    {
      key: "updated",
      header: "Updated",
      cell: (thread) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {DATE.format(new Date(thread.updatedAt))}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      cell: (thread) => {
        const needsRevision = thread.effectiveStatus === "NEEDS_REVISION";
        const nextVersionNo =
          (thread.latestVersion.versionNo ?? thread.versionCount) + 1;
        return (
          <div className="flex items-center justify-end gap-1.5">
            {needsRevision && (
              <Button
                type="button"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => onOpenDrawer(thread.rootId)}
              >
                <FileUp className="mr-1 h-3 w-3" />
                Upload v{nextVersionNo}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onOpenDrawer(thread.rootId)}
            >
              <Eye className="mr-1 h-3 w-3" />
              Preview
            </Button>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
            >
              <a
                href={getAppointmentDocumentUrl(
                  thread.appointmentId,
                  thread.latestVersion.id,
                  "attachment",
                )}
              >
                <Download className="h-3.5 w-3.5" />
                <span className="sr-only">Download</span>
              </a>
            </Button>
          </div>
        );
      },
    },
  ];
}

const MATERIAL_COLUMNS: ResponsiveColumn<ConsulteeMaterialRow>[] = [
  {
    key: "name",
    header: "Material",
    primary: true,
    cell: (m) => (
      <div className="space-y-0.5">
        <a
          href={getPlanMaterialUrl(m.id, "inline")}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{m.originalName}</span>
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </a>
        <p className="text-[11px] text-muted-foreground">
          {formatFileSize(m.fileSize)}
          {m.description ? ` · ${m.description}` : ""}
        </p>
      </div>
    ),
  },
  {
    key: "plan",
    header: "Plan / Offering",
    cell: (m) => <span className="text-foreground">{m.planTitle}</span>,
  },
  {
    key: "expert",
    header: "Expert",
    cell: (m) => (
      <span className="text-muted-foreground">{m.consultantName ?? "—"}</span>
    ),
  },
  {
    key: "date",
    header: "Added",
    cell: (m) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {DATE.format(new Date(m.uploadedAt))}
      </span>
    ),
  },
  {
    key: "download",
    header: "",
    cell: (m) => (
      <div className="flex justify-end">
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <a href={getPlanMaterialUrl(m.id, "attachment")}>
            <Download className="mr-1 h-3.5 w-3.5" />
            Download
          </a>
        </Button>
      </div>
    ),
  },
];

export function ConsulteeDocumentsPage({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const queryClient = useQueryClient();
  const { page, setPage } = useListParams();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [drawerRootId, setDrawerRootId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consultee-documents", consulteeId, page, statusFilter],
    queryFn: () => fetchDocuments(consulteeId, page, statusFilter),
    placeholderData: keepPreviousData,
  });

  const threads = useMemo(() => {
    const grouped = groupDocumentsIntoThreads(data?.data ?? []);
    if (!search.trim()) return grouped;
    const q = search.trim().toLowerCase();
    return grouped.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.latestVersion.appointmentTitle.toLowerCase().includes(q) ||
        (t.latestVersion.consultantName?.toLowerCase().includes(q) ?? false) ||
        (t.effectiveReviewNotes?.toLowerCase().includes(q) ?? false),
    );
  }, [data?.data, search]);

  const drawerThread = useMemo(
    () =>
      drawerRootId
        ? (threads.find((t) => t.rootId === drawerRootId) ?? null)
        : null,
    [drawerRootId, threads],
  );

  const filteredMaterials = useMemo(() => {
    const items = data?.materials ?? [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (m) =>
        m.originalName.toLowerCase().includes(q) ||
        m.planTitle.toLowerCase().includes(q) ||
        (m.consultantName?.toLowerCase().includes(q) ?? false),
    );
  }, [data?.materials, search]);

  const threadColumns = useMemo(
    () => buildThreadColumns(basePath, setDrawerRootId),
    [basePath],
  );

  const isFirstLoad = isLoading && !data;

  const deliverablesTabContent = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_CHIPS.map((chip) => {
          const active = statusFilter === chip.value;
          return (
            <Button
              key={chip.label}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => {
                setStatusFilter(chip.value);
                setPage(1);
              }}
            >
              {chip.label}
            </Button>
          );
        })}
      </div>

      <ResponsiveTable<DocumentThread<ConsulteeDocumentRow>>
        columns={threadColumns}
        rows={threads}
        getRowId={(t) => t.rootId}
        isLoading={isFirstLoad}
        error={error}
        onRetry={() => void refetch()}
        empty={
          <p className="py-8 text-center text-sm text-muted-foreground">
            No deliverables match your filters yet. Upload documents from a
            confirmed booking to start a review thread.
          </p>
        }
      />
      {data && data.count > PAGE_SIZE && (
        <TablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.count}
          onPageChange={setPage}
        />
      )}
    </div>
  );

  const materialsTabContent = (
    <ResponsiveTable<ConsulteeMaterialRow>
      columns={MATERIAL_COLUMNS}
      rows={filteredMaterials}
      getRowId={(m) => m.id}
      isLoading={isFirstLoad}
      error={error}
      onRetry={() => void refetch()}
      empty={
        <p className="py-8 text-center text-sm text-muted-foreground">
          Handouts attached to your booked plans appear here.
        </p>
      }
    />
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Documents"
        description="Your deliverable review threads, expert feedback, and handouts for booked offerings"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search files, sessions, or feedback"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files, sessions, feedback..."
            className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      <UrlTabs
        tabs={[
          {
            value: "files",
            label: data ? `Deliverables · ${threads.length}` : "Deliverables",
            content: deliverablesTabContent,
          },
          {
            value: "materials",
            label: data
              ? `Plan materials · ${filteredMaterials.length}`
              : "Plan materials",
            content: materialsTabContent,
          },
        ]}
      />

      <DocumentReviewDrawer
        thread={drawerThread}
        isOpen={Boolean(drawerThread)}
        onClose={() => setDrawerRootId(null)}
        viewerRole="consultee"
        canUpload
        onUpdated={() => {
          void queryClient.invalidateQueries({
            queryKey: ["consultee-documents", consulteeId],
          });
        }}
      />
    </div>
  );
}
