"use client";

import type { ReactNode } from "react";

import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { formatFileSize } from "@/lib/documents/document-utils";
import {
  THREAD_STATUS_CHIP,
  THREAD_STATUS_NEUTRAL,
  VERSION_STATUS_CHIP,
} from "@/lib/documents/thread-copy";
import type {
  LibraryDocument,
  LibraryMaterial,
  LibrarySession,
  LibraryThreadVersion,
} from "@/lib/library/library-query";
import {
  LibraryTable,
  OpenFileLink,
  LibraryDate,
  type LibraryColumn,
} from "./LibraryTable";

type WithSession<T> = T & { session?: LibrarySession };

function ThreadTitle({ thread }: Readonly<{ thread: LibraryDocument }>) {
  const renamed = thread.latest.originalName !== thread.title;
  return (
    <div className="min-w-0 max-w-[22rem]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate font-medium text-foreground">
          {thread.title}
        </span>
        {thread.versionCount > 1 && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            v{thread.latest.versionNo} · {thread.versionCount} versions
          </span>
        )}
      </div>
      {renamed && (
        <p className="truncate text-xs text-muted-foreground">
          Latest: {thread.latest.originalName}
        </p>
      )}
    </div>
  );
}

function ThreadStatusCell({ thread }: Readonly<{ thread: LibraryDocument }>) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge
        label={
          thread.needsYou ? "Your turn" : THREAD_STATUS_NEUTRAL[thread.status]
        }
        tone={
          thread.needsYou ? "caution" : THREAD_STATUS_CHIP[thread.status].tone
        }
        size="sm"
      />
      {thread.removalRequested && (
        <StatusBadge label="Removal requested" tone="warning" size="sm" />
      )}
    </span>
  );
}

function VersionList({
  thread,
}: Readonly<{ thread: LibraryDocument }>): ReactNode {
  return (
    <ol
      aria-label={`Versions of ${thread.title}, newest first`}
      className="space-y-1.5"
    >
      {thread.versions.map((version: LibraryThreadVersion) => {
        const chip = version.reviewStatus
          ? VERSION_STATUS_CHIP[version.reviewStatus]
          : null;
        return (
          <li
            key={version.id}
            className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-xs"
          >
            <span className="w-8 shrink-0 font-medium tabular-nums text-foreground">
              v{version.versionNo}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">
                {version.originalName}
              </span>
              {version.reviewNotesExcerpt && (
                <span className="block text-muted-foreground">
                  Note: {version.reviewNotesExcerpt}
                </span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {version.uploadedBy}
            </span>
            {version.isExpertReply && (
              <StatusBadge label="Expert reply" tone="neutral" size="sm" />
            )}
            {chip && (
              <StatusBadge label={chip.label} tone={chip.tone} size="sm" />
            )}
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">
              <LibraryDate iso={version.uploadedAt} />
            </span>
            <OpenFileLink
              href={version.url}
              label={`Open v${version.versionNo} of ${thread.title}`}
            />
          </li>
        );
      })}
    </ol>
  );
}

/** One expandable row per document thread; the panel lists every version. */
export function ThreadTable<T extends WithSession<LibraryDocument>>({
  threads,
  bookingColumn,
}: Readonly<{
  threads: T[];
  bookingColumn?: LibraryColumn<T>;
}>) {
  const columns: LibraryColumn<T>[] = [
    {
      key: "title",
      header: "Document",
      cell: (t) => <ThreadTitle thread={t} />,
    },
    ...(bookingColumn ? [bookingColumn] : []),
    {
      key: "startedBy",
      header: "Started by",
      cell: (t) => <span className="text-muted-foreground">{t.startedBy}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => <ThreadStatusCell thread={t} />,
    },
    {
      key: "updated",
      header: "Updated",
      cell: (t) => (
        <span className="whitespace-nowrap text-muted-foreground">
          <LibraryDate iso={t.latest.uploadedAt} />
        </span>
      ),
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      className: "w-10",
      cell: (t) => (
        <OpenFileLink
          href={t.latest.url}
          label={`Open the latest version of ${t.title}`}
        />
      ),
    },
  ];
  return (
    <LibraryTable
      caption="Documents"
      columns={columns}
      rows={threads}
      getRowId={(t) => `${t.session?.appointmentId ?? ""}:${t.id}`}
      detail={(t) => <VersionList thread={t} />}
      detailLabel={(t) => `Show the versions of ${t.title}`}
    />
  );
}

/** The plan's materials: files, not threads, so no status. */
export function MaterialsTable<T extends WithSession<LibraryMaterial>>({
  materials,
  bookingColumn,
}: Readonly<{
  materials: T[];
  bookingColumn?: LibraryColumn<T>;
}>) {
  const columns: LibraryColumn<T>[] = [
    {
      key: "title",
      header: "Material",
      cell: (m) => (
        <span className="block max-w-[22rem] truncate font-medium text-foreground">
          {m.title}
        </span>
      ),
    },
    ...(bookingColumn ? [bookingColumn] : []),
    {
      key: "type",
      header: "Type",
      cell: (m) => <span className="text-muted-foreground">{m.fileType}</span>,
    },
    {
      key: "size",
      header: "Size",
      cell: (m) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatFileSize(m.fileSize)}
        </span>
      ),
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      className: "w-10",
      cell: (m) => <OpenFileLink href={m.url} label={`Open ${m.title}`} />,
    },
  ];
  return (
    <LibraryTable
      caption="Plan materials"
      columns={columns}
      rows={materials}
      getRowId={(m) => `${m.session?.appointmentId ?? ""}:${m.id}`}
    />
  );
}
