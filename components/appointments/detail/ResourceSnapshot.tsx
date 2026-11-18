"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  ExternalLink,
  FileText,
  Paperclip,
  Video,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import { formatFileSize } from "@/lib/documents/document-utils";
import {
  documentKeys,
  materialKeys,
  recordingKeys,
} from "@/lib/documents/query-keys";
import {
  THREAD_STATUS_CHIP,
  readOnlyNotice,
  windowNotice,
} from "@/lib/documents/thread-copy";
import { threadNeedsViewer } from "@/lib/documents/thread-view";
import { getMaterialViewerUrl } from "@/lib/documents/urls";
import { useFileDownload } from "@/lib/documents/use-file-download";
import type { DocumentWorkspace } from "@/lib/documents/workspace";
import type { BookingMaterial } from "@/lib/plans/booking-materials";
import {
  keptUntilText,
  partLabel,
  slotStateText,
} from "@/lib/stream/recording-copy";
import type { RecordingBookingView } from "@/lib/stream/recording-slots";
import { useZonedFormat } from "@/lib/time/zoned-format";

const RETRYABLE = new Set([
  "SERVER_ERROR",
  "NETWORK",
  "STORAGE_UNAVAILABLE",
  "RATE_LIMITED",
]);

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new FileActionError(friendlyFileError("NETWORK"));
  }
  if (!res.ok) throw new FileActionError(await friendlyErrorFromResponse(res));
  return res.json();
}

export interface ResourceHrefs {
  documents: string;
  recordings: string;
}

function Card({
  title,
  icon: Icon,
  children,
}: Readonly<{ title: string; icon: typeof FileText; children: ReactNode }>) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

function CardError({
  error,
  onRetry,
  notFoundCopy,
}: Readonly<{ error: unknown; onRetry: () => void; notFoundCopy: string }>) {
  const code = error instanceof FileActionError ? error.code : "SERVER_ERROR";
  const copy =
    code === "NOT_FOUND"
      ? notFoundCopy
      : error instanceof FileActionError
        ? error.message
        : friendlyFileError("SERVER_ERROR").description;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>{copy}</p>
      {RETRYABLE.has(code) && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 min-h-9 sm:min-h-0"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

function CardLink({
  href,
  children,
}: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 pt-1 text-xs font-medium text-primary hover:underline"
    >
      {children} <span aria-hidden>&rarr;</span>
    </Link>
  );
}

function DocumentsCard({
  appointmentId,
  href,
}: Readonly<{ appointmentId: string; href: string }>) {
  const format = useZonedFormat();
  const day = (iso: string) => format(iso, "d MMM yyyy");
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: documentKeys.workspace(appointmentId),
    queryFn: () =>
      getJson<DocumentWorkspace>(
        `/api/appointments/${encodeURIComponent(appointmentId)}/documents`,
      ),
    staleTime: 30_000,
  });
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (error || !data) {
    return (
      <CardError
        error={error}
        onRetry={() => void refetch()}
        notFoundCopy="Documents are shared between the booking's learner and expert."
      />
    );
  }
  const { booking, threads } = data;
  const needs = threads.filter((t) =>
    threadNeedsViewer(t, booking.viewerRole),
  ).length;
  const latest = threads[0];
  const notice = booking.readOnlyReason
    ? readOnlyNotice({
        reason: booking.readOnlyReason,
        terminalAt: booking.terminalAt,
        closesAt: booking.uploadWindow.closesAt,
        keptUntil: booking.keptUntil,
        day,
      })
    : windowNotice({
        closesAt: booking.uploadWindow.closesAt,
        keptUntil: booking.keptUntil,
        day,
      })[0];
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-foreground">
        {threads.length === 0
          ? booking.viewerRole === "expert"
            ? "Nothing shared yet."
            : "No documents yet. Share files with your expert from the documents page."
          : `${threads.length} ${threads.length === 1 ? "document" : "documents"}${
              needs > 0 ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : ""
            }`}
      </p>
      {latest && (
        <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className="truncate">{latest.title}</span>
          <StatusBadge
            label={
              booking.viewerRole === "expert"
                ? THREAD_STATUS_CHIP[latest.status].expert
                : THREAD_STATUS_CHIP[latest.status].learner
            }
            tone={THREAD_STATUS_CHIP[latest.status].tone}
            size="sm"
          />
        </p>
      )}
      <p className="text-muted-foreground">{notice}</p>
      <CardLink href={href}>Open documents</CardLink>
    </div>
  );
}

const MATERIALS_PREVIEW = 3;

function MaterialsCard({ appointmentId }: Readonly<{ appointmentId: string }>) {
  const [expanded, setExpanded] = useState(false);
  const { downloadMaterial } = useFileDownload();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: materialKeys.appointment(appointmentId),
    queryFn: () =>
      getJson<{ materials: BookingMaterial[] }>(
        `/api/appointments/${encodeURIComponent(appointmentId)}/materials`,
      ),
    staleTime: 60_000,
  });
  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (error || !data) {
    return (
      <CardError
        error={error}
        onRetry={() => void refetch()}
        notFoundCopy="No materials for this offering."
      />
    );
  }
  const materials = data.materials;
  if (materials.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No materials for this offering.
      </p>
    );
  }
  const shown = expanded ? materials : materials.slice(0, MATERIALS_PREVIEW);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Files included with this offering. Open or download them here.
      </p>
      <ul className="space-y-1">
        {shown.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="min-w-0 truncate text-foreground" title={m.name}>
              {m.name}{" "}
              <span className="text-muted-foreground">
                · {formatFileSize(m.fileSize)}
              </span>
            </span>
            <span className="flex shrink-0 items-center">
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="h-7 px-2 min-h-9 sm:min-h-0"
              >
                <a
                  href={getMaterialViewerUrl(m.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open
                  <ExternalLink className="ml-1 h-3 w-3" aria-hidden />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 min-h-9 sm:min-h-0"
                aria-label={`Download ${m.name}`}
                onClick={() => void downloadMaterial(m.id)}
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {materials.length > MATERIALS_PREVIEW && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs min-h-9 sm:min-h-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? "Show fewer"
            : `+ ${materials.length - MATERIALS_PREVIEW} more`}
        </Button>
      )}
    </div>
  );
}

function RecordingsCard({
  appointmentId,
  href,
}: Readonly<{ appointmentId: string; href: string }>) {
  const format = useZonedFormat();
  const day = (iso: string) => format(iso, "d MMM yyyy");
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: recordingKeys.appointment(appointmentId),
    queryFn: () =>
      getJson<RecordingBookingView>(
        `/api/appointments/${encodeURIComponent(appointmentId)}/recordings`,
      ),
    staleTime: 30_000,
  });
  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (error || !data) {
    return (
      <CardError
        error={error}
        onRetry={() => void refetch()}
        notFoundCopy="Recordings are available to this booking's attendees."
      />
    );
  }
  const withParts = data.slots.filter((s) => s.parts.length > 0);
  const latest = withParts.at(-1);
  const latestPart = latest?.parts.at(-1);
  // A cancelled or released session has no recording to explain; the schedule shows it.
  const lastEnded = [...data.slots]
    .reverse()
    .find((s) => s.state !== "upcoming" && s.state !== "cancelled");
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-foreground">
        {withParts.length === 0
          ? "No recordings yet. Recorded sessions appear here after processing."
          : data.slots.length > 1
            ? `${withParts.length} of ${data.slots.length} sessions recorded`
            : "Recorded"}
      </p>
      {latest && latestPart && (
        <p className="text-muted-foreground">
          Latest: Session {latest.ordinal}
          {latest.parts.length > 1 ? ` · ${latest.parts.length} parts` : ""}
          {latest.state === "catch_up" ? " · catch-up" : ""}
          {keptUntilText(latestPart.keptUntil, day)
            ? ` · ${keptUntilText(latestPart.keptUntil, day)}`
            : ""}
        </p>
      )}
      {lastEnded && lastEnded.parts.length === 0 && (
        <p className="text-muted-foreground">{slotStateText(lastEnded, day)}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {latest && latestPart && (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-7 min-h-9 sm:min-h-0"
          >
            <Link
              href={`${href}?slot=${latest.ordinal}&r=${encodeURIComponent(latestPart.recordingId)}`}
            >
              Watch latest
              {partLabel(latestPart) ? ` (${partLabel(latestPart)})` : ""}
            </Link>
          </Button>
        )}
        <CardLink href={href}>Open recordings</CardLink>
      </div>
    </div>
  );
}

/** The hub's brief of a booking's documents, materials and recordings; the work happens on their own pages. */
export function ResourceSnapshot({
  appointmentId,
  supportsDocuments,
  hrefs,
}: Readonly<{
  appointmentId: string;
  supportsDocuments: boolean;
  hrefs: ResourceHrefs;
}>) {
  return (
    <div className="space-y-5">
      {supportsDocuments && (
        <>
          <Card title="Documents" icon={FileText}>
            <DocumentsCard
              appointmentId={appointmentId}
              href={hrefs.documents}
            />
          </Card>
          <div className="border-t border-border" />
        </>
      )}
      <Card title="Materials" icon={Paperclip}>
        <MaterialsCard appointmentId={appointmentId} />
      </Card>
      <div className="border-t border-border" />
      <Card title="Recordings" icon={Video}>
        <RecordingsCard appointmentId={appointmentId} href={hrefs.recordings} />
      </Card>
    </div>
  );
}
