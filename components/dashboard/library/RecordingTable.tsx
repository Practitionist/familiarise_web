"use client";

import { Play } from "lucide-react";

import type {
  LibraryRecording,
  LibraryRecordingPart,
  LibrarySession,
} from "@/lib/library/library-query";
import { keptUntilText } from "@/lib/stream/recording-copy";
import {
  LibraryTable,
  formatLibraryDate,
  type LibraryColumn,
} from "./LibraryTable";

type Row = LibraryRecording & { session?: LibrarySession };

function PlayButton({
  label,
  onPlay,
}: Readonly<{ label: string; onPlay: () => void }>) {
  return (
    <button
      type="button"
      onClick={onPlay}
      className="inline-flex max-w-full items-center gap-1.5 text-left font-medium text-foreground underline-offset-4 hover:underline"
    >
      <Play
        className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

function lengthText(row: LibraryRecording): string {
  if (row.parts.length === 0) return "—";
  const parts = row.parts.length > 1 ? `${row.parts.length} parts · ` : "";
  return `${parts}${row.durationInMinutes} min`;
}

/** One row per session; a session recorded in several parts expands into them. */
export function RecordingTable<T extends Row>({
  rows,
  bookingColumn,
  onPlay,
}: Readonly<{
  rows: T[];
  bookingColumn?: LibraryColumn<T>;
  onPlay: (part: LibraryRecordingPart, row: T) => void;
}>) {
  const columns: LibraryColumn<T>[] = [
    {
      key: "title",
      header: "Recording",
      cell: (r) =>
        r.parts.length === 1 ? (
          <div className="min-w-0 max-w-[22rem]">
            <PlayButton label={r.title} onPlay={() => onPlay(r.parts[0]!, r)} />
            {r.notice && (
              <span className="block text-xs text-muted-foreground">
                {r.notice}
              </span>
            )}
          </div>
        ) : (
          <div className="min-w-0 max-w-[22rem]">
            <span className="block truncate font-medium text-foreground">
              {r.title}
            </span>
            {r.notice && (
              <span className="block text-xs text-muted-foreground">
                {r.notice}
              </span>
            )}
          </div>
        ),
    },
    ...(bookingColumn ? [bookingColumn] : []),
    {
      key: "session",
      header: "Session",
      cell: (r) => (
        <span className="text-muted-foreground">
          {[r.sessionLabel, r.catchUpFrom].filter(Boolean).join(" · ") || "—"}
        </span>
      ),
    },
    {
      key: "length",
      header: "Length",
      cell: (r) => {
        const kept = keptUntilText(r.keptUntil, formatLibraryDate);
        return (
          <span className="text-muted-foreground">
            {lengthText(r)}
            {kept ? ` · ${kept}` : ""}
          </span>
        );
      },
    },
    {
      key: "recorded",
      header: "Recorded",
      cell: (r) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatLibraryDate(r.recordedAt)}
        </span>
      ),
    },
  ];
  return (
    <LibraryTable
      caption="Recordings"
      columns={columns}
      rows={rows}
      getRowId={(r) => `${r.session?.appointmentId ?? ""}:${r.id}`}
      detail={(r) =>
        r.parts.length > 1 ? (
          <ol aria-label={`Parts of ${r.title}`} className="space-y-1.5">
            {r.parts.map((part) => (
              <li
                key={part.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-xs"
              >
                <PlayButton
                  label={part.partLabel ?? part.title}
                  onPlay={() => onPlay(part, r)}
                />
                <span className="text-muted-foreground">
                  {part.durationInMinutes} min
                </span>
                <span className="whitespace-nowrap text-muted-foreground">
                  {formatLibraryDate(part.recordedAt)}
                </span>
              </li>
            ))}
          </ol>
        ) : null
      }
      detailLabel={(r) => `Show the parts of ${r.title}`}
    />
  );
}
