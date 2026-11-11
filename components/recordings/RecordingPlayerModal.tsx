"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  AlertCircle,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Cloud,
  ExternalLink,
  FileText,
  Gauge,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import { z } from "zod";
import {
  friendlyFileError,
  resolveFileErrorCode,
} from "@/lib/documents/file-errors";
import { buildCaptionTrackDataUri } from "./caption-track";
import { planTypeLabel } from "@/lib/labels/plan-labels";

export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
export type DateOrIsoString = string | Date | null;

export interface RecordingPlayerItem {
  id: string;
  title: string;
  playbackUrl?: string | null;
  durationMinutes?: number | null;
  durationInMinutes?: number | null;
  recordedAt?: DateOrIsoString;
  resolution?: string | null;
  storageType?: string | null;
  previewTranscript?: string | null;
  planType?: string | null;
  planTitle?: string | null;
  appointmentHref?: string | null;
}

export interface ResolvedPlaybackState {
  recordingId: string;
  url: string;
  previewTranscript?: string | null;
}

export interface RecordingPlayerModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly recording: RecordingPlayerItem | null;
  /** "Part 2 of 3" and similar, shown under the title. */
  readonly partLabel?: string | null;
  /** Plays the session's next part. */
  readonly onNextPart?: (() => void) | null;
}

const PlaybackPayloadSchema = z.object({
  code: z.string().optional(),
  removedAt: z.string().nullish(),
  removalReason: z.string().nullish(),
  recording: z
    .object({
      playbackUrl: z.string().nullish(),
      previewTranscript: z.string().nullish(),
    })
    .optional(),
  access: z
    .object({ level: z.string().optional(), reason: z.string().optional() })
    .optional(),
});

const removedDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const PLAYBACK_STALL_MS = 20_000;

const REMOVED_BY_COPY: Partial<Record<string, string>> = {
  EXPERT_DELETED: "the expert",
  SUPPORT_ACTION: "Familiarise support",
};

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "SERVER_ERROR",
  "NETWORK",
  "STORAGE_UNAVAILABLE",
  "VENDOR_UNAVAILABLE",
  "RATE_LIMITED",
]);

/** A refusal with fixed copy; a retry is offered only when it could succeed. */
class PlaybackRefusal extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PlaybackRefusal";
  }
}

/** Fixed copy for a playback refusal; server text is never shown. */
function playbackErrorCopy(
  status: number,
  payload: z.infer<typeof PlaybackPayloadSchema>,
): string {
  const code = resolveFileErrorCode(status, payload.code);
  if (code === "GONE") {
    const by = payload.removalReason
      ? REMOVED_BY_COPY[payload.removalReason]
      : undefined;
    if (by && payload.removedAt) {
      return `Removed by ${by} on ${removedDay.format(new Date(payload.removedAt))}.`;
    }
    return "This recording is no longer available.";
  }
  if (code === "NOT_FOUND") return "This recording is no longer available.";
  return friendlyFileError(code).description;
}

export function resolveActivePlaybackUrl(
  recording: Pick<RecordingPlayerItem, "id" | "playbackUrl"> | null,
  resolvedPlayback: ResolvedPlaybackState | null,
): string | null {
  if (!recording) return null;
  if (resolvedPlayback?.recordingId === recording.id) {
    return resolvedPlayback.url;
  }
  return recording.playbackUrl ?? null;
}

function formatDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || minutes <= 0) return null;
  return `${minutes} min`;
}

function computeStorageBadge(
  storageType?: string | null,
): { label: string; permanent: boolean } | null {
  if (storageType === "PLATFORM") {
    return { label: "Saved to library", permanent: true };
  }
  if (storageType === "STREAM_S3") {
    return { label: "Saving to library", permanent: false };
  }
  return null;
}

interface PlayerViewportProps {
  readonly lastUrl: string | null;
  readonly isLoadingUrl: boolean;
  readonly fetchError: string | null;
  /** False for refusals a retry cannot change (access, removal). */
  readonly canRetry: boolean;
  readonly activePlaybackUrl: string | null;
  readonly captionTrackSrc: string;
  readonly videoRef: React.RefObject<HTMLVideoElement>;
  readonly savedTimeRef: React.MutableRefObject<number>;
  readonly playbackSpeed: PlaybackSpeed;
  readonly onRetry: () => void;
  readonly onVideoError: () => void;
  readonly onVideoCanPlay: () => void;
  readonly onVideoLoaded: () => void;
}

function PlayerViewport({
  lastUrl,
  isLoadingUrl,
  fetchError,
  canRetry,
  activePlaybackUrl,
  captionTrackSrc,
  videoRef,
  savedTimeRef,
  playbackSpeed,
  onRetry,
  onVideoError,
  onVideoCanPlay,
  onVideoLoaded,
}: Readonly<PlayerViewportProps>) {
  if (fetchError) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2.5 rounded-lg border border-border bg-muted/40 p-6 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          This recording can&apos;t be played
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">{fetchError}</p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {canRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Retry
            </Button>
          )}
          {lastUrl && (
            <Button variant="ghost" size="sm" asChild>
              <a href={lastUrl} target="_blank" rel="noopener noreferrer">
                Open in new tab
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
              </a>
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (activePlaybackUrl) {
    return (
      <video
        ref={videoRef}
        src={activePlaybackUrl}
        controls
        autoPlay
        preload="metadata"
        controlsList="nodownload"
        className="w-full rounded-lg bg-black aspect-video"
        onTimeUpdate={(event) => {
          if (event.currentTarget.currentTime > 0) {
            savedTimeRef.current = event.currentTarget.currentTime;
          }
        }}
        onLoadedMetadata={() => {
          onVideoLoaded();
          if (videoRef.current) {
            if (savedTimeRef.current > 0) {
              videoRef.current.currentTime = savedTimeRef.current;
            }
            videoRef.current.playbackRate = playbackSpeed;
          }
        }}
        onCanPlay={onVideoCanPlay}
        onError={onVideoError}
      >
        <track
          kind="captions"
          srcLang="en"
          label="Transcript"
          src={captionTrackSrc}
        />
      </video>
    );
  }

  if (isLoadingUrl) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-white/80" />
        <p className="text-xs text-white/70">
          Preparing secure video stream...
        </p>
      </div>
    );
  }

  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground">
      Playback URL unavailable.
    </div>
  );
}

export function RecordingPlayerModal({
  open,
  onOpenChange,
  recording,
  partLabel = null,
  onNextPart = null,
}: Readonly<RecordingPlayerModalProps>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const savedTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [resolvedPlayback, setResolvedPlayback] =
    useState<ResolvedPlaybackState | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [retriedOnError, setRetriedOnError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadedAttempt, setLoadedAttempt] = useState<number | null>(null);

  const recordingId = recording?.id ?? null;
  const initialPlaybackUrl = recording?.playbackUrl ?? null;

  const fetchPresignedUrl = useCallback(async (id: string) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoadingUrl(true);
    setFetchError(null);
    setCanRetry(true);
    try {
      const response = await fetch(`/api/stream/recordings/${id}`, {
        signal: controller.signal,
      });
      const parsed = PlaybackPayloadSchema.safeParse(
        await response.json().catch(() => ({})),
      );
      const payload = parsed.success ? parsed.data : {};
      if (controller.signal.aborted) return;

      if (!response.ok) {
        throw new PlaybackRefusal(
          playbackErrorCopy(response.status, payload),
          RETRYABLE_CODES.has(
            resolveFileErrorCode(response.status, payload.code),
          ),
        );
      }
      const nextUrl = payload.recording?.playbackUrl ?? null;
      if (!nextUrl) {
        const metadataOnly = payload.access?.level === "METADATA_ONLY";
        throw new PlaybackRefusal(
          metadataOnly
            ? "Organisation and staff roles can see this recording's details but not play it."
            : "This recording is still processing. Try again in a few minutes.",
          !metadataOnly,
        );
      }
      setResolvedPlayback({
        recordingId: id,
        url: nextUrl,
        previewTranscript: payload.recording?.previewTranscript ?? null,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setCanRetry(!(err instanceof PlaybackRefusal) || err.retryable);
      setFetchError(
        err instanceof Error && !(err instanceof TypeError)
          ? err.message
          : friendlyFileError("NETWORK").description,
      );
    } finally {
      if (abortControllerRef.current === controller) {
        setIsLoadingUrl(false);
      }
    }
  }, []);

  // Sync latest initialPlaybackUrl in a ref so URL refreshes from props never reset savedTimeRef.
  const initialPlaybackUrlRef = useRef(initialPlaybackUrl);
  useEffect(() => {
    initialPlaybackUrlRef.current = initialPlaybackUrl;
  }, [initialPlaybackUrl]);

  useEffect(() => {
    abortControllerRef.current?.abort();
    savedTimeRef.current = 0;
    setResolvedPlayback(null);
    setFetchError(null);
    setPlaybackSpeed(1);
    setTranscriptOpen(false);
    setRetriedOnError(false);
    setLoadedAttempt(null);

    if (!open || !recordingId) {
      setIsLoadingUrl(false);
      return;
    }

    if (!initialPlaybackUrlRef.current) {
      void fetchPresignedUrl(recordingId);
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [open, recordingId, fetchPresignedUrl]);

  const handleSpeedChange = (speed: PlaybackSpeed) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  const activePlaybackUrl = resolveActivePlaybackUrl(
    recording,
    resolvedPlayback,
  );

  /** One fresh URL and reload per failure; a second failure shows the error state. */
  const failPlayback = useCallback(() => {
    if (!recordingId) return;
    savedTimeRef.current = videoRef.current?.currentTime ?? 0;
    if (retriedOnError) {
      setFetchError(friendlyFileError("MEDIA_UNPLAYABLE").description);
      return;
    }
    setRetriedOnError(true);
    void fetchPresignedUrl(recordingId).then(() => setAttempt((a) => a + 1));
  }, [recordingId, retriedOnError, fetchPresignedUrl]);

  // Reload per attempt: a retried URL may be identical, so the src alone would not reload.
  useEffect(() => {
    if (attempt > 0) videoRef.current?.load();
  }, [attempt]);

  // A source that never reaches its metadata (stalled or unreachable) counts as a failure.
  useEffect(() => {
    if (!open || !activePlaybackUrl || fetchError || isLoadingUrl) return;
    if (loadedAttempt === attempt) return;
    const timer = setTimeout(failPlayback, PLAYBACK_STALL_MS);
    return () => clearTimeout(timer);
  }, [
    open,
    activePlaybackUrl,
    fetchError,
    isLoadingUrl,
    loadedAttempt,
    attempt,
    failPlayback,
  ]);

  if (!recording) return null;

  const durationMins =
    recording.durationMinutes ?? recording.durationInMinutes ?? null;
  const formattedDuration = formatDuration(durationMins);
  const storageBadge = computeStorageBadge(recording.storageType);
  const fetchedTranscript =
    resolvedPlayback?.recordingId === recording.id
      ? (resolvedPlayback.previewTranscript ?? null)
      : null;
  const transcriptText =
    recording.previewTranscript?.trim() || fetchedTranscript?.trim() || null;
  const captionTrackSrc = buildCaptionTrackDataUri(transcriptText);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-5 sm:p-6">
        <DialogHeader className="space-y-1.5 pr-6 text-left">
          <div className="flex flex-wrap items-center gap-2">
            {recording.planType && (
              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {planTypeLabel(recording.planType)}
              </span>
            )}
            {storageBadge && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
                  storageBadge.permanent
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                <Cloud className="h-3 w-3" />
                {storageBadge.label}
              </span>
            )}
            {recording.resolution && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {recording.resolution}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold leading-snug">
            {recording.title}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {recording.planTitle && <span>{recording.planTitle}</span>}
            {partLabel && <span>{partLabel}</span>}
            {recording.recordedAt && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {format(new Date(recording.recordedAt), "d MMM yyyy")}
              </span>
            )}
            {formattedDuration && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {formattedDuration}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <PlayerViewport
            lastUrl={activePlaybackUrl}
            isLoadingUrl={isLoadingUrl}
            fetchError={fetchError}
            canRetry={canRetry}
            activePlaybackUrl={activePlaybackUrl}
            captionTrackSrc={captionTrackSrc}
            videoRef={videoRef}
            savedTimeRef={savedTimeRef}
            playbackSpeed={playbackSpeed}
            onRetry={() => {
              setRetriedOnError(false);
              void fetchPresignedUrl(recording.id).then(() =>
                setAttempt((a) => a + 1),
              );
            }}
            onVideoCanPlay={() => {
              setRetriedOnError(false);
            }}
            onVideoLoaded={() => setLoadedAttempt(attempt)}
            onVideoError={failPlayback}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <fieldset
              aria-label="Playback speed"
              className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0"
            >
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Gauge className="h-3.5 w-3.5" />
                Speed:
              </span>
              {PLAYBACK_SPEEDS.map((speed) => (
                <Button
                  key={speed}
                  type="button"
                  size="sm"
                  variant={playbackSpeed === speed ? "default" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => handleSpeedChange(speed)}
                >
                  {speed}x
                </Button>
              ))}
            </fieldset>

            <div className="flex flex-wrap items-center gap-2">
              {onNextPart && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={onNextPart}
                >
                  Next part
                </Button>
              )}
              {recording.appointmentHref && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  asChild
                >
                  <Link href={recording.appointmentHref}>
                    Session details <span aria-hidden>&rarr;</span>
                  </Link>
                </Button>
              )}
              {activePlaybackUrl && !fetchError && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  asChild
                >
                  <a
                    href={activePlaybackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in New Tab
                    <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
            </div>
          </div>

          {transcriptText && (
            <div className="rounded-lg border border-border bg-muted/40">
              <button
                type="button"
                onClick={() => setTranscriptOpen((prev) => !prev)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-medium text-foreground hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  Transcript / Notes
                </span>
                {transcriptOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {transcriptOpen && (
                <div className="border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-line max-h-48 overflow-y-auto">
                  {transcriptText}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
