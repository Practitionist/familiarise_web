"use client";

import { useState } from "react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FileText,
  Play,
  Video,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { eventUnionStatusBadge } from "@/lib/appointments/status-guards";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { RecordingPlayerModal } from "@/components/recordings/RecordingPlayerModal";
import { FileOpenLink } from "@/components/documents/FileOpenLink";
import { getMaterialViewerUrl } from "@/lib/documents/urls";
import { useFileDownload } from "@/lib/documents/use-file-download";

export interface EventResource {
  id: string;
  /** Set only when the viewer is a party to this run. */
  appointmentId?: string | null;
  /** A shared recording from a run or batch the viewer did not attend. */
  fromOtherRun?: boolean;
  planTitle: string;
  contextTitle?: string | null;
  consultantName: string;
  consultantImage: string | null;
  status: string;
  date: string;
  eventType?: string;
  offeringType?: string;
  sourceType?: string;
  classId?: string | null;
  webinarId?: string | null;
  classPlan?: { id?: string; title?: string } | null;
  webinarPlan?: { id?: string; title?: string } | null;
  materials: {
    id: string;
    fileName: string;
    originalName: string;
    fileSize: number;
    mimeType: string;
    fileUrl: string;
    description: string | null;
    order: number;
    uploadedAt: string;
  }[];
  recordings: {
    id: string;
    title: string;
    durationInMinutes: number;
    recordedAt: string;
    thumbnailUrl: string | null;
    status: string;
    previewTranscript?: string | null;
  }[];
}

export function getRecordingStatusLabel(status: string): string {
  if (status === "EXPIRED") return "Expired";
  if (status === "FAILED") return "Unavailable";
  return "Processing";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function getEmptyStateMessage(status: string): string {
  switch (status) {
    case "SCHEDULED":
    case "IN_PROGRESS":
      return "Recordings will appear here after the session ends.";
    case "CANCELLED":
      return "This event was cancelled — no recordings are available.";
    case "COMPLETED":
      return "No recordings were captured for this session.";
    default:
      return "No materials or recordings yet.";
  }
}

/**
 * Which artifacts this card renders.
 *
 * Documents and Recordings are separate destinations now, so one card is asked
 * for one kind at a time. "both" is the original behaviour and stays for any
 * caller that wants the combined view.
 */
export type ResourceArtifact = "materials" | "recordings" | "both";

export function EventResourceCard({
  consulteeId,
  event,
  artifact = "both",
}: {
  consulteeId?: string;
  event: EventResource;
  artifact?: ResourceArtifact;
}) {
  const { downloadMaterial } = useFileDownload();
  const showMaterials = artifact === "materials" || artifact === "both";
  const showRecordings = artifact === "recordings" || artifact === "both";
  const totalItems =
    (showMaterials ? event.materials.length : 0) +
    (showRecordings ? event.recordings.length : 0);
  const [expanded, setExpanded] = useState(totalItems > 0);
  const [activeRecording, setActiveRecording] = useState<
    EventResource["recordings"][number] | null
  >(null);

  const appointmentHref =
    consulteeId && event.appointmentId
      ? `/dashboard/consultee/${consulteeId}/appointments/${event.appointmentId}`
      : null;

  const otherRunLabel = event.fromOtherRun
    ? event.classId || event.offeringType === "CLASS"
      ? "From another batch"
      : "From another run"
    : null;

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      {/* Header: the toggle and the session link are siblings, never nested. */}
      <div className="flex items-center gap-3 p-4 transition-colors hover:bg-muted">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-4 text-left"
        >
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarImage
              src={event.consultantImage || undefined}
              alt={event.consultantName || "Expert"}
            />
            <AvatarFallback className="bg-muted text-muted-foreground text-sm">
              {event.consultantName?.charAt(0) || "?"}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground truncate">
              {event.planTitle}
            </h3>
            <p className="text-sm text-muted-foreground">
              {event.consultantName || "Unknown"} &middot;{" "}
              {formatDate(event.date)}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <StatusBadge {...eventUnionStatusBadge(event.status)} size="sm" />
            {totalItems > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {showMaterials && event.materials.length > 0 && (
                  <span className="flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5" aria-hidden />
                    {event.materials.length}
                  </span>
                )}
                {showRecordings && event.recordings.length > 0 && (
                  <span className="flex items-center gap-1">
                    <Video className="w-3.5 h-3.5" aria-hidden />
                    {event.recordings.length}
                  </span>
                )}
              </div>
            )}
            {expanded ? (
              <ChevronUp
                className="w-4 h-4 text-muted-foreground/70"
                aria-hidden
              />
            ) : (
              <ChevronDown
                className="w-4 h-4 text-muted-foreground/70"
                aria-hidden
              />
            )}
          </div>
        </button>

        {appointmentHref ? (
          <Link
            href={appointmentHref}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            Session details <span aria-hidden>&rarr;</span>
          </Link>
        ) : (
          otherRunLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {otherRunLabel}
            </span>
          )
        )}
      </div>

      {/* Content */}
      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {totalItems === 0 && (
            <p className="text-sm text-muted-foreground/70 text-center py-3">
              {getEmptyStateMessage(event.status)}
            </p>
          )}

          {/* Materials */}
          {showMaterials && event.materials.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Materials Provided ({event.materials.length})
              </h4>
              <div className="space-y-2">
                {event.materials.map((mat) => (
                  <div
                    key={mat.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/60 hover:bg-muted transition-colors group"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-card text-muted-foreground border border-border shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <FileOpenLink
                        href={getMaterialViewerUrl(mat.id)}
                        className="inline-flex max-w-full items-center gap-1 text-sm font-medium text-foreground hover:underline underline-offset-4"
                      >
                        <span className="truncate">
                          {mat.originalName || mat.fileName}
                        </span>
                        <ExternalLink
                          className="h-3 w-3 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      </FileOpenLink>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(mat.fileSize)}
                        {mat.description && ` \u00B7 ${mat.description}`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => void downloadMaterial(mat.id)}
                    >
                      <Download className="w-3.5 h-3.5 mr-1" />
                      Download
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recordings */}
          {showRecordings && event.recordings.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Session Recordings ({event.recordings.length})
              </h4>
              <div className="space-y-2">
                {event.recordings.map((rec) => {
                  const canWatch =
                    rec.status === "AVAILABLE" ||
                    rec.status === "READY" ||
                    rec.status === "TRANSFERRING";
                  const retentionHint =
                    event.offeringType === "WEBINAR" ||
                    event.offeringType === "CLASS" ||
                    event.webinarId ||
                    event.classId
                      ? "1yr replay"
                      : "90d retention";
                  return (
                    <div
                      key={rec.id}
                      className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/60 hover:bg-muted transition-colors group"
                    >
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-lg shrink-0",
                          canWatch
                            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300"
                            : "bg-card text-muted-foreground/70 border border-border",
                        )}
                      >
                        <Video className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {rec.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDuration(rec.durationInMinutes)} &middot;{" "}
                          {formatDate(rec.recordedAt)} &middot; {retentionHint}
                        </p>
                      </div>
                      {canWatch ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveRecording(rec);
                          }}
                          className="h-8 px-3 text-xs font-medium text-emerald-700 border-emerald-200 hover:bg-emerald-50 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-950"
                        >
                          <Play className="w-3.5 h-3.5 mr-1" />
                          Watch
                        </Button>
                      ) : (
                        <span
                          className={cn(
                            "text-xs px-2",
                            rec.status === "FAILED"
                              ? "text-destructive"
                              : "text-muted-foreground/70",
                          )}
                        >
                          {getRecordingStatusLabel(rec.status)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <RecordingPlayerModal
        open={Boolean(activeRecording)}
        onOpenChange={(open) => {
          if (!open) setActiveRecording(null);
        }}
        recording={
          activeRecording
            ? {
                id: activeRecording.id,
                title: activeRecording.title,
                recordedAt: activeRecording.recordedAt,
                durationInMinutes: activeRecording.durationInMinutes,
                previewTranscript: activeRecording.previewTranscript ?? null,
                planTitle: event.planTitle,
                appointmentHref,
              }
            : null
        }
      />
    </div>
  );
}
