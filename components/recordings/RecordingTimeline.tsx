"use client";

import Link from "next/link";
import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronRight, Info, Play } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  LibraryRecording,
  LibraryRecordingPart,
  LibraryRetention,
  LibraryTimeline,
} from "@/lib/library/library-query";
import {
  catchUpExplainer,
  keptUntilText,
  removedPartBadge,
  retentionText,
  rowBadge,
  timelineSubline,
} from "@/lib/stream/recording-copy";
import { rowRetention } from "@/lib/stream/recording-timeline";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { cn } from "@/utils/tailwind";

/**
 * One layout for a booking's recordings in the Library and on the booking's
 * Recordings page: a header that says when and how long once, then one row
 * per session of the viewer's own booking, with parts under the same columns.
 */

const MUTED = new Set(["upcoming", "before_you_joined", "cancelled"]);

function useDates() {
  const format = useZonedFormat();
  return {
    day: (iso: string) => format(iso, "d MMM yyyy"),
    shortDay: (iso: string) => format(iso, "EEE d MMM"),
    dateTime: (iso: string) => format(iso, "EEE d MMM yyyy, h:mm a"),
  };
}

function PlayButton({
  label,
  srLabel,
  onPlay,
}: Readonly<{ label: ReactNode; srLabel: string; onPlay: () => void }>) {
  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={srLabel}
      className="inline-flex items-center gap-1.5 rounded-md text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Play
        className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      />
      {label}
    </button>
  );
}

export interface TimelineTableProps {
  caption: string;
  rows: LibraryRecording[];
  /** The card's retention; rows repeat theirs only when it differs or ends soon. */
  retention: LibraryRetention | null;
  onPlay: (part: LibraryRecordingPart, row: LibraryRecording) => void;
  /** Extra controls in a row's action cell (the host's Manage). */
  manage?: (row: LibraryRecording) => ReactNode;
  /** The same for each part of a multi-part session. */
  managePart?: (part: LibraryRecordingPart, row: LibraryRecording) => ReactNode;
  /** Rows carry `slot-<n>` ids so a `?slot=` link can scroll to them. */
  anchorRows?: boolean;
  /** The flat view's leading booking cell. */
  booking?: { header: string; cell: (row: LibraryRecording) => ReactNode };
  moreUpcoming?: { count: number; href: string } | null;
}

export function RecordingTimelineTable({
  caption,
  rows,
  retention,
  onPlay,
  manage,
  managePart,
  anchorRows = false,
  booking,
  moreUpcoming,
}: Readonly<TimelineTableProps>) {
  const base = useId();
  const { day, shortDay } = useDates();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const now = new Date();
  const columnCount = booking ? 5 : 4;
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-x-auto">
      <TooltipProvider delayDuration={150}>
        <Table className="table-fixed">
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              {booking && (
                <TableHead className="w-48">{booking.header}</TableHead>
              )}
              <TableHead className="w-36">Session</TableHead>
              <TableHead>Recording</TableHead>
              <TableHead className="w-24">Length</TableHead>
              <TableHead className="w-40 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const muted = MUTED.has(row.state);
              const multi = row.parts.length + row.removedParts.length > 1;
              const expanded = multi && open.has(row.id);
              const partIds = [
                ...row.parts.map((_, i) => `${base}-${index}-part-${i}`),
                ...row.removedParts.map(
                  (_, i) => `${base}-${index}-removed-${i}`,
                ),
              ];
              const badge = rowBadge(row, day);
              const kept = rowRetention(row, retention, now);
              const first = row.parts[0];
              const playable = first && row.state !== "before_you_joined";
              return (
                <Fragment key={row.id}>
                  <TableRow
                    id={
                      anchorRows && row.slotOrdinal !== null
                        ? `slot-${row.slotOrdinal}`
                        : undefined
                    }
                    className={cn(
                      muted && "text-muted-foreground",
                      expanded && "border-b-0",
                    )}
                  >
                    {booking && (
                      <TableCell className="align-top">
                        {booking.cell(row)}
                      </TableCell>
                    )}
                    <TableCell className="align-top">
                      <span className="whitespace-nowrap">
                        {row.slotOrdinal !== null
                          ? `${row.slotOrdinal} · ${shortDay(row.sessionAt)}`
                          : day(row.sessionAt)}
                      </span>
                      {multi && (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={partIds.join(" ")}
                          onClick={() => toggle(row.id)}
                          className="mt-1 flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronRight
                            className={cn(
                              "h-3.5 w-3.5 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden
                          />
                          {row.removedParts.length > 0
                            ? `${row.parts.length} of ${row.parts.length + row.removedParts.length} parts available`
                            : `${row.parts.length} parts`}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <span
                        className={cn(
                          "block truncate",
                          !muted && "font-medium text-foreground",
                        )}
                      >
                        {row.title}
                      </span>
                      {badge && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          {badge}
                          {row.catchUp && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label="Why a catch-up"
                                >
                                  <Info className="h-3.5 w-3.5" aria-hidden />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-xs">
                                {catchUpExplainer(row.catchUp.from)}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      )}
                      {kept && (
                        <span
                          className={cn(
                            "mt-1 inline-block rounded px-1.5 py-0.5 text-[11px]",
                            kept.warning
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {keptUntilText(kept.label, day)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      {row.parts.length > 0 && row.state !== "upcoming"
                        ? `${row.durationInMinutes} min`
                        : "—"}
                    </TableCell>
                    <TableCell className="align-top text-right">
                      <span className="inline-flex items-center justify-end gap-2">
                        {playable && (
                          <PlayButton
                            label={
                              multi && first.partLabel
                                ? `Play ${first.partLabel.split(" of ")[0]!.toLowerCase()}`
                                : "Play"
                            }
                            srLabel={`Play ${row.title}${multi && first.partLabel ? `, ${first.partLabel}` : ""}`}
                            onPlay={() => onPlay(first, row)}
                          />
                        )}
                        {manage?.(row)}
                      </span>
                    </TableCell>
                  </TableRow>
                  {multi &&
                    row.parts.map((part, i) => (
                      <TableRow
                        key={part.id}
                        id={partIds[i]}
                        hidden={!expanded}
                        className="border-b-0 bg-muted/30 hover:bg-muted/30"
                      >
                        {booking && <TableCell />}
                        <TableCell />
                        <TableCell className="py-1.5">
                          <PlayButton
                            label={part.partLabel ?? part.title}
                            srLabel={`Play ${row.title}, ${part.partLabel ?? part.title}`}
                            onPlay={() => onPlay(part, row)}
                          />
                        </TableCell>
                        <TableCell className="py-1.5 whitespace-nowrap text-muted-foreground">
                          {part.durationInMinutes} min
                        </TableCell>
                        <TableCell className="py-1.5 text-right">
                          {managePart?.(part, row)}
                        </TableCell>
                      </TableRow>
                    ))}
                  {multi &&
                    row.removedParts.map((removed, i) => (
                      <TableRow
                        key={`removed-${removed.partNo}`}
                        id={partIds[row.parts.length + i]}
                        hidden={!expanded}
                        className="border-b-0 bg-muted/30 text-muted-foreground hover:bg-muted/30"
                      >
                        {booking && <TableCell />}
                        <TableCell />
                        <TableCell className="py-1.5 text-xs" colSpan={3}>
                          {removedPartBadge(removed, day)}
                        </TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
            {moreUpcoming && moreUpcoming.count > 0 && (
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableCell colSpan={columnCount} className="text-xs">
                  <Link
                    href={moreUpcoming.href}
                    className="underline-offset-4 hover:underline"
                  >
                    {moreUpcoming.count} more upcoming session
                    {moreUpcoming.count === 1 ? "" : "s"}
                  </Link>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TooltipProvider>
    </div>
  );
}

/** A booking's recordings card: title and expert, when, how long once, then the timeline. */
export function RecordingTimelineCard({
  title,
  expertName,
  kind,
  timeline,
  bookingHref,
  moreHref,
  ...table
}: Readonly<
  Omit<TimelineTableProps, "retention" | "moreUpcoming" | "caption"> & {
    title: string;
    expertName: string | null;
    kind: string;
    timeline: LibraryTimeline;
    /** "Open booking" in the header; null where the page already links back. */
    bookingHref: string | null;
    /** Where "<n> more upcoming sessions" leads; defaults to the booking. */
    moreHref?: string;
  }
>) {
  const { day, dateTime } = useDates();
  const subline = timelineSubline(kind, timeline, day, dateTime);
  return (
    <section
      aria-label={title}
      className="rounded-xl border border-border bg-card"
    >
      <div className="space-y-0.5 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
            {title}
            {expertName ? ` · ${expertName}` : ""}
          </h3>
          {bookingHref && (
            <Link
              href={bookingHref}
              className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Open booking <span aria-hidden>&rarr;</span>
            </Link>
          )}
        </div>
        {subline && <p className="text-xs text-muted-foreground">{subline}</p>}
        {timeline.retention && (
          <p className="text-xs text-muted-foreground">
            {retentionText(
              timeline.retention,
              day,
              timeline.viewerRole === "host",
            )}
          </p>
        )}
      </div>
      <div className="border-t border-border px-2 pb-2">
        <RecordingTimelineTable
          {...table}
          caption={`Recordings of ${title}`}
          retention={timeline.retention}
          moreUpcoming={
            (moreHref ?? bookingHref) && timeline.moreUpcoming > 0
              ? {
                  count: timeline.moreUpcoming,
                  href: moreHref ?? bookingHref ?? "",
                }
              : null
          }
        />
      </div>
    </section>
  );
}
