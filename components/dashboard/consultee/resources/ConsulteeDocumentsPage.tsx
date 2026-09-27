"use client";

import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

import { PageHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useListParams } from "@/hooks/useListParams";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import type {
  ConsulteeDocumentRow,
  ConsulteeDocumentsPayload,
  ConsulteeMaterialRow,
} from "@/lib/data/consultee-documents";

// Type-only import above: lib/data pulls prisma, which a client bundle cannot.
const PAGE_SIZE = 20;

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function FileLink({ href, name }: Readonly<{ href: string; name: string }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
    >
      <span className="truncate">{name}</span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

async function fetchDocuments(
  consulteeId: string,
  page: number,
): Promise<ConsulteeDocumentsPayload> {
  const offset = (page - 1) * PAGE_SIZE;
  const res = await fetch(
    `/api/dashboard/consultee/${consulteeId}/documents?limit=${PAGE_SIZE}&offset=${offset}`,
  );
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

/**
 * The consultee Documents page (#1527 §7.1): every file for the learner's
 * bookings in one place — their uploads and the expert's responses (paged),
 * and the plan materials of what they booked. Recordings are their own page,
 * so the vendor recording-sync button no longer sits here.
 */
export function ConsulteeDocumentsPage({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const { page, setPage } = useListParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consultee-documents", consulteeId, "all", page],
    queryFn: () => fetchDocuments(consulteeId, page),
    placeholderData: keepPreviousData,
  });

  const fileColumns: ResponsiveColumn<ConsulteeDocumentRow>[] = [
    {
      key: "name",
      header: "File",
      primary: true,
      cell: (doc) => <FileLink href={doc.fileUrl} name={doc.originalName} />,
    },
    {
      key: "booking",
      header: "Booking",
      cell: (doc) => (
        <Link
          href={`${basePath}/appointments/${doc.appointmentId}`}
          className="text-foreground underline-offset-4 hover:underline"
        >
          {doc.appointmentTitle}
        </Link>
      ),
    },
    {
      key: "from",
      header: "From",
      cell: (doc) => (
        <span className="text-muted-foreground">
          {doc.uploadedByRole === "CONSULTANT"
            ? (doc.consultantName ?? "Your expert")
            : "You"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Review",
      cell: (doc) =>
        doc.uploadedByRole === "CONSULTEE" ? (
          <StatusBadge
            {...documentReviewStatusBadge(doc.reviewStatus)}
            size="sm"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "date",
      header: "Date",
      cell: (doc) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {DATE.format(new Date(doc.uploadedAt))}
        </span>
      ),
    },
  ];

  const materialColumns: ResponsiveColumn<ConsulteeMaterialRow>[] = [
    {
      key: "name",
      header: "Material",
      primary: true,
      cell: (m) => <FileLink href={m.fileUrl} name={m.originalName} />,
    },
    {
      key: "plan",
      header: "Plan",
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
        <span className="whitespace-nowrap text-muted-foreground">
          {DATE.format(new Date(m.uploadedAt))}
        </span>
      ),
    },
  ];

  const isFirstLoad = isLoading && !data;

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Your files, your expert's responses and the materials for the sessions you've booked"
      />
      <UrlTabs
        tabs={[
          {
            value: "files",
            label: data ? `Your bookings · ${data.count}` : "Your bookings",
            content: (
              <div className="space-y-3">
                <ResponsiveTable<ConsulteeDocumentRow>
                  columns={fileColumns}
                  rows={data?.data ?? []}
                  getRowId={(doc) => doc.id}
                  isLoading={isFirstLoad}
                  error={error}
                  onRetry={() => void refetch()}
                  empty={
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No files yet. Upload documents from a confirmed booking,
                      and your expert&apos;s responses land here too.
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
            ),
          },
          {
            value: "materials",
            label: data
              ? `Plan materials · ${data.materials.length}`
              : "Plan materials",
            content: (
              <ResponsiveTable<ConsulteeMaterialRow>
                columns={materialColumns}
                rows={data?.materials ?? []}
                getRowId={(m) => m.id}
                isLoading={isFirstLoad}
                error={error}
                onRetry={() => void refetch()}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Handouts your experts attach to their plans appear here.
                  </p>
                }
              />
            ),
          },
        ]}
      />
    </div>
  );
}
