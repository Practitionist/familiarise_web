"use client";

/**
 * The Library list: one page of bookings with their rows, grouped per booking
 * or flat, with search, kind, person, status, date and source filters. Every
 * value lives in the URL (`useListParams`); the server pages by booking.
 * Rows only open a file or play a recording; all other work happens on the
 * booking's Documents or Recordings page.
 */

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, FolderOpen, Play } from "lucide-react";

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
import {
  RecordingPlayerModal,
  type RecordingPlayerItem,
} from "@/components/recordings/RecordingPlayerModal";
import { useListParams } from "@/hooks/useListParams";
import {
  THREAD_STATUS_CHIP,
  THREAD_STATUS_NEUTRAL,
} from "@/lib/documents/thread-copy";
import {
  DOCUMENT_SOURCE_LABEL,
  LIBRARY_DOC_STATUSES,
  LIBRARY_DOC_STATUS_LABEL,
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
import { keptUntilText } from "@/lib/stream/recording-copy";
import { cn } from "@/utils/tailwind";

type Artifact = "documents" | "recordings";
type LibraryFile = LibraryDocument | LibraryRecording;
type FlatRow = LibraryFile & { session: LibrarySession };

const FILTER_KEYS = [
  "kind",
  "from",
  "to",
  "source",
  "person",
  "status",
  "view",
] as const;

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
  /** The booking's Documents or Recordings page. */
  sessionHref: (appointmentId: string) => string;
  /** Documents only: the source filter's options. */
  sources?: DocumentSource[];
  /** The person filter's label ("Learner", "Expert" or "Person"). */
  personLabel: string;
  emptyDescription: string;
  /** Extra controls in the filter row (e.g. a sync action). */
  actions?: ReactNode;
}

function isDocument(file: LibraryFile): file is LibraryDocument {
  return "source" in file;
}

function toPlayerItem(
  recording: LibraryRecording,
  session: Pick<LibrarySession, "title" | "kind"> | null,
  href: string | null,
): RecordingPlayerItem {
  return {
    id: recording.id,
    title: recording.title,
    recordedAt: recording.recordedAt,
    durationInMinutes: recording.durationInMinutes,
    planTitle: session?.title ?? null,
    planType: session ? LIBRARY_KIND_LABEL[session.kind] : null,
    appointmentHref: href,
  };
}

function FileCell({
  file,
  onWatch,
}: Readonly<{ file: LibraryFile; onWatch?: () => void }>) {
  if (!isDocument(file)) {
    if (!file.playable || !onWatch) {
      return (
        <span className="text-foreground">{file.notice ?? file.title}</span>
      );
    }
    return (
      <button
        type="button"
        onClick={onWatch}
        className="inline-flex max-w-full items-center gap-1.5 text-left font-medium text-foreground underline-offset-4 hover:underline"
      >
        <Play
          className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
        <span className="truncate">{file.title}</span>
      </button>
    );
  }
  if (!file.url) return <span className="text-foreground">{file.name}</span>;
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
    >
      <span className="truncate">{file.name}</span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function detailCells(file: LibraryFile) {
  if (isDocument(file)) {
    const status = file.status;
    return {
      meta: DOCUMENT_SOURCE_LABEL[file.source],
      status: status ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StatusBadge
            label={file.needsYou ? "Your turn" : THREAD_STATUS_NEUTRAL[status]}
            tone={file.needsYou ? "caution" : THREAD_STATUS_CHIP[status].tone}
            size="sm"
          />
          {file.removalRequested && (
            <StatusBadge label="Removal requested" tone="warning" size="sm" />
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      date: fmt(file.uploadedAt),
    };
  }
  const kept = keptUntilText(file.keptUntil, (iso) => fmt(iso));
  return {
    meta:
      [
        file.sessionLabel,
        file.catchUpFrom ? `Catch-up from ${file.catchUpFrom}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "—",
    status: (
      <span className="text-muted-foreground">
        {file.playable ? `${file.durationInMinutes} min` : "—"}
        {kept ? ` · ${kept}` : ""}
      </span>
    ),
    date: fmt(file.recordedAt),
  };
}

function fileColumns<T extends LibraryFile>(
  artifact: Artifact,
  session: ResponsiveColumn<T> | undefined,
  onWatch: (row: T) => void,
): ResponsiveColumn<T>[] {
  const docs = artifact === "documents";
  return [
    {
      key: "name",
      header: docs ? "Document" : "Recording",
      primary: true,
      cell: (f) => <FileCell file={f} onWatch={() => onWatch(f)} />,
    },
    ...(session ? [session] : []),
    {
      key: "meta",
      header: docs ? "From" : "Session",
      cell: (f) => (
        <span className="text-muted-foreground">{detailCells(f).meta}</span>
      ),
    },
    {
      key: "status",
      header: docs ? "Status" : "Length",
      cell: (f) => detailCells(f).status,
    },
    {
      key: "date",
      header: docs ? "Updated" : "Recorded",
      cell: (f) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {detailCells(f).date}
        </span>
      ),
    },
  ];
}

function summaryText(group: LibraryGroup<LibraryFile>): string | null {
  const s = group.summary;
  if (s?.documents) {
    return `${s.documents.threads} documents · ${s.documents.open} open · ${s.documents.done} done`;
  }
  if (s?.recordings) {
    return `${s.recordings.count} recordings · ${s.recordings.minutes} min`;
  }
  return null;
}

function SessionGroup({
  group,
  artifact,
  href,
  onWatch,
}: Readonly<{
  group: LibraryGroup<LibraryFile>;
  artifact: Artifact;
  href: string;
  onWatch: (recording: LibraryRecording, session: LibrarySession) => void;
}>) {
  const [open, setOpen] = useState(true);
  const { session, files } = group;
  const summary = summaryText(group);
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
            disabled={files.length === 0}
          >
            {files.length > 0 && (
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  !open && "-rotate-90",
                )}
                aria-hidden
              />
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {session.title}
                {session.counterpartName && ` · ${session.counterpartName}`}
              </span>
              <span className="block text-xs text-muted-foreground">
                {LIBRARY_KIND_LABEL[session.kind] ?? session.kind} ·{" "}
                {fmt(session.startsAt)}
                {summary ? ` · ${summary}` : ""}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        {files.length > 0 && (
          <Link
            href={href}
            className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {artifact === "documents" ? "Open documents" : "Open recordings"}{" "}
            <span aria-hidden>&rarr;</span>
          </Link>
        )}
      </div>
      {files.length > 0 && (
        <CollapsibleContent className="border-t border-border px-2 pb-2">
          <ResponsiveTable<LibraryFile>
            columns={fileColumns<LibraryFile>(artifact, undefined, (f) => {
              if (!isDocument(f)) onWatch(f, session);
            })}
            rows={files}
            getRowId={(f) => f.id}
          />
        </CollapsibleContent>
      )}
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
  personLabel,
  emptyDescription,
  actions,
}: Readonly<LibraryBrowserProps>) {
  const [activeRecording, setActiveRecording] =
    useState<RecordingPlayerItem | null>(null);
  const list = useListParams({ filterKeys: FILTER_KEYS });
  const { q, page, filters } = list;
  const flat = filters.view === "flat";
  const docs = artifact === "documents";

  const search = new URLSearchParams(fixedParams);
  if (q) search.set("q", q);
  if (page > 1) search.set("page", String(page));
  for (const key of [
    "kind",
    "from",
    "to",
    "source",
    "person",
    "status",
  ] as const) {
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
  const noun = docs ? "documents" : "recordings";

  const sessionColumn: ResponsiveColumn<FlatRow> = {
    key: "session",
    header: "Booking",
    cell: (row) => (
      <Link
        href={sessionHref(row.session.appointmentId)}
        className="text-foreground underline-offset-4 hover:underline"
      >
        {row.session.title}
      </Link>
    ),
  };

  const watch = (recording: LibraryRecording, session: LibrarySession | null) =>
    setActiveRecording(
      toPlayerItem(
        recording,
        session,
        session
          ? `${sessionHref(session.appointmentId)}${
              recording.slotOrdinal ? `?slot=${recording.slotOrdinal}` : ""
            }`
          : null,
      ),
    );

  const empty = (
    <EmptyState
      icon={FolderOpen}
      title={filtered ? `No ${noun} match` : `No ${noun} yet`}
      description={filtered ? "Try another filter." : emptyDescription}
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
        columns={fileColumns<FlatRow>(artifact, sessionColumn, (row) => {
          if (!isDocument(row)) watch(row, row.session);
        })}
        rows={data ? (flattenLibrary(data.groups) as FlatRow[]) : []}
        getRowId={(row) => `${row.session.appointmentId}:${row.id}`}
        isLoading={isLoading && !data}
        empty={empty}
      />
    );
  } else if (data?.groups.length === 0 && !data.purchased?.length) {
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
            onWatch={watch}
          />
        ))}
      </div>
    );
  }

  const people = data?.facets?.people ?? [];
  const selects = [
    ...(people.length > 0
      ? [
          {
            key: "person",
            label: personLabel,
            value: filters.person ?? "all",
            options: [
              { value: "all", label: `Every ${personLabel.toLowerCase()}` },
              ...people.map((p) => ({ value: p.id, label: p.name })),
            ],
            onChange: (v: string) =>
              list.setFilter("person", v === "all" ? null : v),
          },
        ]
      : []),
    ...(docs
      ? [
          {
            key: "status",
            label: "Status",
            value: filters.status ?? "all",
            options: [
              { value: "all", label: "Any status" },
              ...LIBRARY_DOC_STATUSES.map((s) => ({
                value: s,
                label: LIBRARY_DOC_STATUS_LABEL[s],
              })),
            ],
            onChange: (v: string) =>
              list.setFilter("status", v === "all" ? null : v),
          },
        ]
      : []),
    ...(sources
      ? [
          {
            key: "source",
            label: "From",
            value: filters.source ?? "all",
            options: [
              { value: "all", label: "Everyone" },
              ...sources.map((s) => ({
                value: s,
                label: DOCUMENT_SOURCE_LABEL[s],
              })),
            ],
            onChange: (v: string) =>
              list.setFilter("source", v === "all" ? null : v),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <FilterBar
        search={{
          label: `Search ${noun}`,
          placeholder: "Booking, plan or file name",
          value: q,
          onChange: list.setQ,
        }}
        chips={{
          label: "Booking kind",
          options: LIBRARY_KINDS.filter(
            (k) =>
              !docs ||
              k === "CONSULTATION" ||
              k === "SUBSCRIPTION" ||
              k === "TRIAL",
          ).map((k) => ({ value: k, label: LIBRARY_KIND_LABEL[k] })),
          value: filters.kind,
          onChange: (v) => list.setFilter("kind", v),
          clearable: true,
        }}
        selects={selects}
        onClear={() =>
          list.setParams({
            q: "",
            filters: {
              kind: null,
              from: null,
              to: null,
              source: null,
              person: null,
              status: null,
            },
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
              [null, "Group by booking"],
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
        {actions}
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

      {!docs && data?.purchased && data.purchased.length > 0 && (
        <section className="space-y-2" aria-label="Purchased replays">
          <h2 className="text-sm font-semibold text-foreground">Purchased</h2>
          <ResponsiveTable<LibraryFile>
            columns={fileColumns<LibraryFile>(artifact, undefined, (f) => {
              if (!isDocument(f)) watch(f, null);
            })}
            rows={data.purchased}
            getRowId={(f) => f.id}
          />
        </section>
      )}

      {!docs && (
        <RecordingPlayerModal
          open={Boolean(activeRecording)}
          onOpenChange={(open) => {
            if (!open) setActiveRecording(null);
          }}
          recording={activeRecording}
        />
      )}
    </div>
  );
}
