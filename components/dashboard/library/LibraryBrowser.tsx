"use client";

/**
 * The Library list (#1527): one page of sessions with their files, grouped
 * per session or flat, with search, kind, date and source filters. Every
 * value lives in the URL (`useListParams`); the server pages by session.
 * Tree-agnostic — the caller names the endpoint and the session link — so
 * the personal Library can adopt it later.
 */

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useListParams } from "@/hooks/useListParams";
import {
  documentReviewStatusBadge,
  recordingStatusBadge,
} from "@/lib/labels/session-labels";
import {
  DOCUMENT_SOURCE_LABEL,
  LIBRARY_KIND_LABEL,
  LIBRARY_KINDS,
  flattenLibrary,
  type DocumentSource,
  type LibraryDocument,
  type LibraryGroup,
  type LibraryPage,
  type LibraryRecording,
  type LibrarySession,
} from "@/lib/library/library-query";
import { cn } from "@/utils/tailwind";

type Artifact = "documents" | "recordings";
type LibraryFile = LibraryDocument | LibraryRecording;
type FlatRow = LibraryFile & { session: LibrarySession };

const FILTER_KEYS = ["kind", "from", "to", "source", "view"] as const;

export const EVENT_TYPE_LABELS: Record<string, string> = {
  ...LIBRARY_KIND_LABEL,
  TRIAL: "Trial",
  consultation: "Consultation",
  subscription: "Subscription",
  webinar: "Webinar",
  class: "Class",
  trial: "Trial",
  purchased: "Purchased",
};

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const fmt = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : "—");

export interface LibraryBrowserProps {
  artifact: Artifact;
  /** The read, without a query string; the browser appends its URL state. */
  endpoint: string;
  /** Fixed params sent on every read, e.g. `{ scope: "mine" }`. */
  fixedParams?: Record<string, string>;
  queryKey: readonly unknown[];
  sessionHref: (appointmentId: string) => string;
  /** Documents only: the source filter's options. */
  sources?: DocumentSource[];
  emptyDescription: string;
}

function isDocument(file: LibraryFile): file is LibraryDocument {
  return "source" in file;
}

function FileCell({ file }: Readonly<{ file: LibraryFile }>) {
  const name = isDocument(file) ? file.name : file.title;
  const href = isDocument(file) ? file.url : file.playbackUrl;
  if (!href) return <span className="text-foreground">{name}</span>;
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

function detailCells(file: LibraryFile) {
  if (isDocument(file)) {
    return {
      meta: DOCUMENT_SOURCE_LABEL[file.source],
      status: file.reviewStatus ? (
        <StatusBadge
          {...documentReviewStatusBadge(file.reviewStatus)}
          size="sm"
        />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      date: fmt(file.uploadedAt),
    };
  }
  return {
    meta: `${file.durationInMinutes} min`,
    status: <StatusBadge {...recordingStatusBadge(file.status)} size="sm" />,
    date: fmt(file.recordedAt),
  };
}

function fileColumns<T extends LibraryFile>(
  artifact: Artifact,
  session?: ResponsiveColumn<T>,
): ResponsiveColumn<T>[] {
  const docs = artifact === "documents";
  return [
    {
      key: "name",
      header: docs ? "File" : "Recording",
      primary: true,
      cell: (f) => <FileCell file={f} />,
    },
    ...(session ? [session] : []),
    {
      key: "meta",
      header: docs ? "Source" : "Length",
      cell: (f) => (
        <span className="text-muted-foreground">{detailCells(f).meta}</span>
      ),
    },
    {
      key: "status",
      header: docs ? "Review" : "Status",
      cell: (f) => detailCells(f).status,
    },
    {
      key: "date",
      header: docs ? "Added" : "Recorded",
      cell: (f) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {detailCells(f).date}
        </span>
      ),
    },
  ];
}

function SessionGroup({
  group,
  artifact,
  href,
}: Readonly<{
  group: LibraryGroup<LibraryFile>;
  artifact: Artifact;
  href: string;
}>) {
  const [open, setOpen] = useState(true);
  const { session, files } = group;
  const noun = artifact === "documents" ? "file" : "recording";
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {session.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                {EVENT_TYPE_LABELS[session.kind] ??
                  LIBRARY_KIND_LABEL[session.kind] ??
                  session.kind}{" "}
                · {fmt(session.startsAt)}
                {session.expertName && ` · ${session.expertName}`} ·{" "}
                {files.length} {files.length === 1 ? noun : `${noun}s`}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        <Link
          href={href}
          className="shrink-0 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Open session
        </Link>
      </div>
      <CollapsibleContent className="border-t border-border px-2 pb-2">
        <ResponsiveTable<LibraryFile>
          columns={fileColumns<LibraryFile>(artifact)}
          rows={files}
          getRowId={(f) => f.id}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function DateField({
  label,
  value,
  onChange,
}: Readonly<{
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
}>) {
  const id = useId();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        type="date"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 w-[9.5rem] text-sm"
      />
    </div>
  );
}

export function LibraryBrowser({
  artifact,
  endpoint,
  fixedParams,
  queryKey,
  sessionHref,
  sources,
  emptyDescription,
}: Readonly<LibraryBrowserProps>) {
  const list = useListParams({ filterKeys: FILTER_KEYS });
  const { q, page, filters } = list;
  const flat = filters.view === "flat";

  const search = new URLSearchParams(fixedParams);
  if (q) search.set("q", q);
  if (page > 1) search.set("page", String(page));
  for (const key of ["kind", "from", "to", "source"] as const) {
    const value = filters[key];
    if (value) search.set(key, value);
  }
  const qs = search.toString();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...queryKey, qs],
    queryFn: async (): Promise<LibraryPage<LibraryFile>> => {
      const res = await fetch(qs ? `${endpoint}?${qs}` : endpoint);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  const filtered =
    !!q || FILTER_KEYS.some((k) => k !== "view" && filters[k] !== null);
  const noun = artifact === "documents" ? "documents" : "recordings";

  const sessionColumn: ResponsiveColumn<FlatRow> = {
    key: "session",
    header: "Session",
    cell: (row) => (
      <Link
        href={sessionHref(row.session.appointmentId)}
        className="text-foreground underline-offset-4 hover:underline"
      >
        {row.session.title}
      </Link>
    ),
  };

  const empty = (
    <EmptyState
      icon={FolderOpen}
      title={filtered ? `No ${noun} match` : `No ${noun} yet`}
      description={
        filtered ? "Try another search or filter." : emptyDescription
      }
    />
  );

  let body: ReactNode;
  if (error && !data) {
    body = (
      <ErrorState
        title={`Couldn't load ${noun}`}
        description="This is a loading problem, not an empty library."
        onRetry={() => void refetch()}
      />
    );
  } else if (flat || (isLoading && !data)) {
    body = (
      <ResponsiveTable<FlatRow>
        columns={fileColumns<FlatRow>(artifact, sessionColumn)}
        rows={data ? (flattenLibrary(data.groups) as FlatRow[]) : []}
        getRowId={(row) => `${row.session.appointmentId}:${row.id}`}
        isLoading={isLoading && !data}
        empty={empty}
      />
    );
  } else if (data?.groups.length === 0) {
    body = empty;
  } else {
    body = (
      <div className="space-y-3">
        {data?.groups.map((group) => (
          <SessionGroup
            key={group.session.appointmentId}
            group={group}
            artifact={artifact}
            href={sessionHref(group.session.appointmentId)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FilterBar
        search={{
          label: `Search ${noun}`,
          placeholder: "Session, plan or file name",
          value: q,
          onChange: list.setQ,
        }}
        chips={{
          label: "Session kind",
          options: LIBRARY_KINDS.map((k) => ({
            value: k,
            label: LIBRARY_KIND_LABEL[k],
          })),
          value: filters.kind,
          onChange: (v) => list.setFilter("kind", v),
          clearable: true,
        }}
        selects={
          sources
            ? [
                {
                  key: "source",
                  label: "Source",
                  value: filters.source ?? "all",
                  options: [
                    { value: "all", label: "All sources" },
                    ...sources.map((s) => ({
                      value: s,
                      label: DOCUMENT_SOURCE_LABEL[s],
                    })),
                  ],
                  onChange: (v) =>
                    list.setFilter("source", v === "all" ? null : v),
                },
              ]
            : undefined
        }
        onClear={() =>
          list.setParams({
            q: "",
            filters: { kind: null, from: null, to: null, source: null },
          })
        }
        canClear={filtered}
      >
        <DateField
          label="From"
          value={filters.from}
          onChange={(v) => list.setFilter("from", v)}
        />
        <DateField
          label="To"
          value={filters.to}
          onChange={(v) => list.setFilter("to", v)}
        />
        <div
          role="group"
          aria-label="Layout"
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
        >
          {(
            [
              [null, "Group by session"],
              ["flat", "Flat list"],
            ] as const
          ).map(([value, label]) => {
            const pressed = (filters.view ?? null) === value;
            return (
              <Button
                key={label}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={pressed}
                // The layout is not a filter: keep the page.
                onClick={() =>
                  list.setParams({ filters: { view: value }, page })
                }
                className={cn(
                  "h-7 px-3 text-sm",
                  pressed
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Button>
            );
          })}
        </div>
      </FilterBar>

      {body}

      {data && data.total > data.pageSize && (
        <TablePagination
          page={page}
          pageSize={data.pageSize}
          total={data.total}
          onPageChange={list.setPage}
        />
      )}
    </div>
  );
}
