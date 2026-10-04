"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  streamUrlExpiresAt?: DateOrIsoString;
  previewTranscript?: string | null;
  planType?: string | null;
  planTitle?: string | null;
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
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

function computeStorageBadge(
  storageType?: string | null,
  streamUrlExpiresAt?: DateOrIsoString,
): { label: string; permanent: boolean } | null {
  if (storageType === "PLATFORM") {
    return { label: "Permanent Cloud Storage", permanent: true };
  }
  if (streamUrlExpiresAt) {
    const expiresMs = new Date(streamUrlExpiresAt).getTime() - Date.now();
    const days = Math.max(0, Math.ceil(expiresMs / (1000 * 60 * 60 * 24)));
    return {
      label: days > 0 ? `Expires in ${days}d` : "Expired",
      permanent: false,
    };
  }
  if (storageType === "STREAM_S3") {
    return { label: "Temporary Stream Storage", permanent: false };
  }
  return null;
}

export function buildCaptionTrackDataUri(
  transcriptText?: string | null,
): string {
  const cueBody = transcriptText?.trim() || "Session recording";
  const vtt = `WEBVTT\n\n00:00:00.000 --> 99:59:59.000\n${cueBody}\n`;
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
}

interface PlayerViewportProps {
  readonly isLoadingUrl: boolean;
  readonly fetchError: string | null;
  readonly activePlaybackUrl: string | null;
  readonly captionTrackSrc: string;
  readonly videoRef: React.RefObject<HTMLVideoElement>;
  readonly playbackSpeed: PlaybackSpeed;
  readonly onRetry: () => void;
  readonly onVideoError: () => void;
}

function PlayerViewport({
  isLoadingUrl,
  fetchError,
  activePlaybackUrl,
  captionTrackSrc,
  videoRef,
  playbackSpeed,
  onRetry,
  onVideoError,
}: Readonly<PlayerViewportProps>) {
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

  if (fetchError) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium text-foreground">{fetchError}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
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
        onLoadedMetadata={() => {
          if (videoRef.current) {
            videoRef.current.playbackRate = playbackSpeed;
          }
        }}
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
}: Readonly<RecordingPlayerModalProps>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [resolvedPlayback, setResolvedPlayback] =
    useState<ResolvedPlaybackState | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [retriedOnError, setRetriedOnError] = useState(false);

  const recordingId = recording?.id ?? null;
  const initialPlaybackUrl = recording?.playbackUrl ?? null;

  const fetchPresignedUrl = useCallback(async (id: string) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoadingUrl(true);
    setFetchError(null);
    try {
      const response = await fetch(`/api/stream/recordings/${id}`, {
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        recording?: {
          playbackUrl?: string | null;
          previewTranscript?: string | null;
        };
        access?: {
          level?: string;
          reason?: string;
        };
        error?: string;
      };
      if (controller.signal.aborted) return;

      if (!response.ok) {
        throw new Error(payload.error || "Unable to load recording playback");
      }
      const nextUrl = payload.recording?.playbackUrl ?? null;
      if (!nextUrl) {
        const operatorReason =
          payload.access?.level === "METADATA_ONLY"
            ? payload.access.reason
            : null;
        throw new Error(
          operatorReason ||
            "Playback URL is not available for this recording yet.",
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
      setFetchError(
        err instanceof Error ? err.message : "Failed to load recording",
      );
    } finally {
      if (abortControllerRef.current === controller) {
        setIsLoadingUrl(false);
      }
    }
  }, []);

  useEffect(() => {
    abortControllerRef.current?.abort();
    setResolvedPlayback(null);
    setFetchError(null);
    setPlaybackSpeed(1);
    setTranscriptOpen(false);
    setRetriedOnError(false);

    if (!open || !recordingId) {
      setIsLoadingUrl(false);
      return;
    }

    if (!initialPlaybackUrl) {
      void fetchPresignedUrl(recordingId);
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [open, recordingId, initialPlaybackUrl, fetchPresignedUrl]);

  const handleSpeedChange = (speed: PlaybackSpeed) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  if (!recording) return null;

  const activePlaybackUrl = resolveActivePlaybackUrl(
    recording,
    resolvedPlayback,
  );
  const durationMins =
    recording.durationMinutes ?? recording.durationInMinutes ?? null;
  const formattedDuration = formatDuration(durationMins);
  const storageBadge = computeStorageBadge(
    recording.storageType,
    recording.streamUrlExpiresAt,
  );
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
              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-primary">
                {recording.planType}
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
            {recording.recordedAt && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {format(new Date(recording.recordedAt), "MMM d, yyyy")}
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
            isLoadingUrl={isLoadingUrl}
            fetchError={fetchError}
            activePlaybackUrl={activePlaybackUrl}
            captionTrackSrc={captionTrackSrc}
            videoRef={videoRef}
            playbackSpeed={playbackSpeed}
            onRetry={() => void fetchPresignedUrl(recording.id)}
            onVideoError={() => {
              if (!retriedOnError) {
                setRetriedOnError(true);
                void fetchPresignedUrl(recording.id);
              }
            }}
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

            {activePlaybackUrl && (
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
