"use client";

/**
 * The Library list: one page of bookings, grouped per booking or flat, with
 * search, kind, person, status, date and source filters. Every value lives in
 * the URL (`useListParams`); the server pages by booking. Document rows are
 * threads that expand into their versions; recording rows are sessions that
 * expand into their parts. All other work happens on the booking's page.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  keepPreviousData,
  useQuery,
  type QueryKey,
} from "@tanstack/react-query";
import { ChevronDown, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { DateRangeMenu } from "@/components/dashboard/DateRangeMenu";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  RecordingPlayerModal,
  type RecordingPlayerItem,
} from "@/components/recordings/RecordingPlayerModal";
import { useListParams } from "@/hooks/useListParams";
import {
  libraryStatusLabel,
  type LibrarySide,
} from "@/lib/documents/thread-copy";
import {
  LIBRARY_DOC_STATUSES,
  LIBRARY_KIND_LABEL,
  LIBRARY_KINDS,
  compareLibraryThreads,
  flattenLibrary,
  libraryQueryString,
  type DocumentSource,
  type LibraryDocument,
  type LibraryGroup,
  type LibraryMaterial,
  type LibraryPage,
  type LibraryRecording,
  type LibraryRecordingPart,
  type LibrarySession,
} from "@/lib/library/library-query";
import { cn } from "@/utils/tailwind";
import { MaterialsTable, ThreadTable } from "./DocumentTables";
import { useLibraryDay, type LibraryColumn } from "./LibraryTable";
import {
  RecordingTimelineCard,
  RecordingTimelineTable,
} from "@/components/recordings/RecordingTimeline";

type Artifact = "documents" | "recordings";
type LibraryFile = LibraryDocument | LibraryRecording;
type Tagged<T> = T & { session: LibrarySession };

const FILTER_KEYS = [
  "kind",
  "from",
  "to",
  "source",
  "person",
  "status",
  "view",
] as const;

const DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "CONSULTATION",
  "SUBSCRIPTION",
  "TRIAL",
]);
const ALL_KINDS = "all";

export interface LibraryBrowserProps {
  artifact: Artifact;
  /** The read, without a query string; the browser appends its URL state. */
  endpoint: string;
  /** Fixed params sent on every read, e.g. `{ scope: "mine" }`. */
  fixedParams?: Record<string, string>;
  queryKey: readonly unknown[];
  /** The booking's Documents or Recordings page. */
  sessionHref: (appointmentId: string) => string;
  /** The booking itself, for a recordings card's "Open booking". */
  bookingHref: (appointmentId: string) => string;
  /** Recordings the viewer hosts get a Manage link to the booking's Recordings page. */
  hostActions?: boolean;
  /** Whose words the status filter uses; org views mix both sides. */
  side: LibrarySide;
  /** Documents only: the "Started by" filter's options. */
  sources?: DocumentSource[];
  /** The person filter's label ("Learner", "Expert" or "Person"). */
  personLabel: string;
  emptyDescription: string;
  /** Extra controls in the filter row (e.g. a sync action). */
  actions?: ReactNode;
}

function toPlayerItem(
  part: LibraryRecordingPart,
  session: Pick<LibrarySession, "title" | "kind"> | null,
  href: string | null,
): RecordingPlayerItem {
  return {
    id: part.id,
    title: part.partLabel ? `${part.title} · ${part.partLabel}` : part.title,
    recordedAt: part.recordedAt,
    durationInMinutes: part.durationInMinutes,
    planTitle: session?.title ?? null,
    planType: session ? LIBRARY_KIND_LABEL[session.kind] : null,
    appointmentHref: href,
  };
}

/** "Subscription · Started 7 Sept 2026 · 6 sessions". */
function sessionLine(
  session: LibrarySession,
  day: (iso: string | null) => string,
): string {
  const kind = LIBRARY_KIND_LABEL[session.kind] ?? session.kind;
  const date =
    session.kind === "SUBSCRIPTION" && session.startsAt
      ? `Started ${day(session.startsAt)}`
      : day(session.startsAt);
  const count =
    session.sessionCount && session.sessionCount > 1
      ? `${session.sessionCount} sessions`
      : null;
  return [kind, date, count].filter(Boolean).join(" · ");
}

function summaryText(group: LibraryGroup<LibraryFile>): string | null {
  const s = group.summary;
  if (s?.documents) {
    return `${s.documents.threads} documents · ${s.documents.open} open · ${s.documents.done} done`;
  }
  if (s?.recordings) {
    const noun = s.recordings.count === 1 ? "recording" : "recordings";
    return `${s.recordings.count} ${noun} · ${s.recordings.minutes} min`;
  }
  return null;
}

/** A documents booking, or an Everyone view's counts-only booking. */
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
  const day = useLibraryDay();
  const { session } = group;
  const materials = group.materials ?? [];
  const hasRows = group.files.length > 0 || materials.length > 0;
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
            disabled={!hasRows}
          >
            {hasRows && (
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
                {sessionLine(session, day)}
                {summary ? ` · ${summary}` : ""}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        {hasRows && (
          <Link
            href={href}
            className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {artifact === "documents" ? "Open documents" : "Open recordings"}{" "}
            <span aria-hidden>&rarr;</span>
          </Link>
        )}
      </div>
      {hasRows && (
        <CollapsibleContent className="space-y-3 border-t border-border px-2 pb-3 pt-2">
          {artifact === "documents" && (
            <>
              {group.files.length > 0 && (
                <section aria-label="Documents">
                  <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Documents
                  </h3>
                  <ThreadTable threads={group.files as LibraryDocument[]} />
                </section>
              )}
              {materials.length > 0 && (
                <section aria-label="Plan materials">
                  <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Plan materials
                  </h3>
                  <MaterialsTable materials={materials} />
                </section>
              )}
            </>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** True when `key` is `base` plus a query string, i.e. the same list. */
function sameList(key: QueryKey, base: QueryKey) {
  return (
    key.length === base.length + 1 && base.every((part, i) => key[i] === part)
  );
}

export function LibraryBrowser({
  artifact,
  endpoint,
  fixedParams,
  queryKey,
  sessionHref,
  bookingHref,
  hostActions = false,
  side,
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

  const qs = libraryQueryString(fixedParams, { q, page, filters });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...queryKey, qs],
    queryFn: async (): Promise<LibraryPage<LibraryFile>> => {
      const res = await fetch(qs ? `${endpoint}?${qs}` : endpoint);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
    // Keep the last page only across this list's own page and filter changes;
    // another list's rows have a different shape.
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameList(previousQuery.queryKey, queryKey)
        ? keepPreviousData(previous)
        : undefined,
  });

  // The Everyone read ignores text, person and source, so they never explain an empty list.
  const everyone = fixedParams?.scope === "everyone";
  const filtered =
    (!everyone && !!q) ||
    FILTER_KEYS.some(
      (k) =>
        k !== "view" &&
        !(everyone && (k === "source" || k === "person")) &&
        filters[k] !== null,
    );
  const noun = docs ? "documents" : "recordings";

  function bookingColumn<T>(): LibraryColumn<Tagged<T>> {
    return {
      key: "booking",
      header: "Booking",
      cell: (row) => (
        <Link
          href={sessionHref(row.session.appointmentId)}
          className="text-foreground underline-offset-4 hover:underline"
        >
          {row.session.title}
          {row.session.counterpartName
            ? ` · ${row.session.counterpartName}`
            : ""}
        </Link>
      ),
    };
  }

  const manageLink =
    (sessionOf: ReadonlyMap<string, LibrarySession>) =>
    (row: LibraryRecording) => {
      const session = sessionOf.get(row.id);
      if (!session || row.parts.length === 0) return null;
      return (
        <Link
          href={`${sessionHref(session.appointmentId)}?slot=${row.slotOrdinal ?? ""}`}
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          aria-label={`Manage ${row.title}`}
        >
          Manage
        </Link>
      );
    };

  const play = (
    part: LibraryRecordingPart,
    session: LibrarySession | null,
    slot: number | null,
  ) =>
    setActiveRecording(
      toPlayerItem(
        part,
        session,
        session
          ? `${sessionHref(session.appointmentId)}${slot ? `?slot=${slot}` : ""}`
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

  const groups = data?.groups ?? [];
  let body: ReactNode;
  if (error && !data) {
    body = (
      <ErrorState
        title={`Couldn't load ${noun}`}
        description="This is a loading problem, not an empty library."
        onRetry={() => void refetch()}
      />
    );
  } else if (isLoading && !data) {
    body = (
      <output aria-busy="true" className="block space-y-3">
        <span className="sr-only">Loading…</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </output>
    );
  } else if (flat && docs) {
    const threads = flattenLibrary(
      groups as LibraryGroup<LibraryDocument>[],
    ).sort(compareLibraryThreads);
    const materials: Tagged<LibraryMaterial>[] =
      filters.source === "materials"
        ? groups.flatMap((g) =>
            (g.materials ?? []).map((m) => ({ ...m, session: g.session })),
          )
        : [];
    body =
      threads.length === 0 && materials.length === 0 ? (
        empty
      ) : (
        <div className="space-y-4 rounded-xl border border-border bg-card p-2">
          {threads.length > 0 && (
            <ThreadTable
              threads={threads}
              bookingColumn={bookingColumn<LibraryDocument>()}
            />
          )}
          {materials.length > 0 && (
            <MaterialsTable
              materials={materials}
              bookingColumn={bookingColumn<LibraryMaterial>()}
            />
          )}
        </div>
      );
  } else if (flat) {
    const rows = flattenLibrary(groups as LibraryGroup<LibraryRecording>[]);
    const sessionOf = new Map(rows.map((r) => [r.id, r.session]));
    body =
      rows.length === 0 ? (
        empty
      ) : (
        <div className="rounded-xl border border-border bg-card p-2">
          <RecordingTimelineTable
            caption="Recordings"
            rows={rows}
            retention={null}
            booking={{
              header: "Booking",
              cell: (row) => {
                const session = sessionOf.get(row.id);
                return session
                  ? bookingColumn<LibraryRecording>().cell({
                      ...row,
                      session,
                    })
                  : null;
              },
            }}
            manage={hostActions ? manageLink(sessionOf) : undefined}
            onPlay={(part, row) =>
              play(part, sessionOf.get(row.id) ?? null, row.slotOrdinal)
            }
          />
        </div>
      );
  } else if (groups.length === 0 && !data?.purchased?.length) {
    body = empty;
  } else {
    const sectionTitle = docs ? "Documents by session" : "Recordings";
    body = (
      <section className="space-y-3" aria-label={sectionTitle}>
        {groups.length > 0 && (
          <h2 className="text-sm font-semibold text-foreground">
            {sectionTitle}
          </h2>
        )}
        {groups.map((group) =>
          !docs && group.timeline ? (
            <RecordingTimelineCard
              key={group.session.appointmentId}
              title={group.session.title}
              expertName={group.session.expertName}
              kind={group.session.kind}
              timeline={group.timeline}
              bookingHref={bookingHref(group.session.appointmentId)}
              rows={group.files as LibraryRecording[]}
              manage={
                hostActions
                  ? manageLink(
                      new Map(
                        (group.files as LibraryRecording[]).map((f) => [
                          f.id,
                          group.session,
                        ]),
                      ),
                    )
                  : undefined
              }
              onPlay={(part, row) => play(part, group.session, row.slotOrdinal)}
            />
          ) : (
            <SessionGroup
              key={group.session.appointmentId}
              group={group}
              artifact={artifact}
              href={sessionHref(group.session.appointmentId)}
            />
          ),
        )}
      </section>
    );
  }

  const people = data?.facets?.people ?? [];
  const chosenPerson = people.find((p) => p.id === filters.person)?.name;
  const sourceLabel = (source: DocumentSource): string => {
    if (source === "materials") return "Plan materials only";
    if (source === "mine") return "Started by you";
    return `Started by ${chosenPerson ?? `the ${source}`}`;
  };
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
                label: libraryStatusLabel(s, side),
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
            label: "Started by",
            value: filters.source ?? "all",
            options: [
              { value: "all", label: "Started by anyone" },
              ...sources.map((s) => ({ value: s, label: sourceLabel(s) })),
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
        search={
          everyone
            ? undefined
            : {
                label: `Search ${noun}`,
                placeholder: "Booking, plan or file name",
                value: q,
                onChange: list.setQ,
              }
        }
        chips={{
          label: "Booking kind",
          options: [
            { value: ALL_KINDS, label: "All" },
            ...LIBRARY_KINDS.filter((k) => !docs || DOCUMENT_KINDS.has(k)).map(
              (k) => ({ value: k, label: LIBRARY_KIND_LABEL[k] }),
            ),
          ],
          value: filters.kind ?? ALL_KINDS,
          onChange: (v) =>
            list.setFilter("kind", v === null || v === ALL_KINDS ? null : v),
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
        <DateRangeMenu
          direction="past"
          value={{ from: filters.from ?? "", to: filters.to ?? "" }}
          onChange={(range) =>
            list.setParams({
              filters: { from: range.from || null, to: range.to || null },
            })
          }
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
          <h2 className="text-sm font-semibold text-foreground">
            Purchased replays
          </h2>
          <p className="text-xs text-muted-foreground">Never expires</p>
          <div className="rounded-xl border border-border bg-card p-2">
            <RecordingTimelineTable
              caption="Purchased replays"
              rows={data.purchased as LibraryRecording[]}
              retention={{ kind: "NEVER" }}
              onPlay={(part) => play(part, null, null)}
            />
          </div>
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
