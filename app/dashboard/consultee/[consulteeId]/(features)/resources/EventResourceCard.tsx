"use client";

import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Play,
  Video,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  formatStatusLabel,
  getStatusStyle,
} from "@/app/dashboard/consultee/[consulteeId]/utils/statusConfig";

export interface EventResource {
  id: string;
  planTitle: string;
  consultantName: string;
  consultantImage: string | null;
  status: string;
  date: string;
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
    playbackUrl: string | null;
    thumbnailUrl: string | null;
    status: string;
  }[];
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

export function EventResourceCard({ event }: { event: EventResource }) {
  const totalItems = event.materials.length + event.recordings.length;
  const [expanded, setExpanded] = useState(totalItems > 0);

  return (
    <div className="bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-4 p-4 hover:bg-zinc-50 transition-colors text-left"
      >
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarImage
            src={event.consultantImage || undefined}
            alt={event.consultantName || "Consultant"}
          />
          <AvatarFallback className="bg-zinc-100 text-zinc-600 text-sm">
            {event.consultantName?.charAt(0) || "?"}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-zinc-900 truncate">
            {event.planTitle}
          </h3>
          <p className="text-sm text-zinc-500">
            {event.consultantName || "Unknown"} &middot;{" "}
            {formatDate(event.date)}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
              (() => {
                const s = getStatusStyle(event.status);
                return `${s.bg} ${s.text}`;
              })(),
            )}
          >
            {formatStatusLabel(event.status)}
          </span>
          {totalItems > 0 && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              {event.materials.length > 0 && (
                <span className="flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5" />
                  {event.materials.length}
                </span>
              )}
              {event.recordings.length > 0 && (
                <span className="flex items-center gap-1">
                  <Video className="w-3.5 h-3.5" />
                  {event.recordings.length}
                </span>
              )}
            </div>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-zinc-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-zinc-400" />
          )}
        </div>
      </button>

      {/* Content */}
      {expanded && (
        <div className="border-t border-zinc-100 p-4 space-y-4">
          {totalItems === 0 && (
            <p className="text-sm text-zinc-400 text-center py-3">
              {getEmptyStateMessage(event.status)}
            </p>
          )}

          {/* Materials */}
          {event.materials.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                Materials ({event.materials.length})
              </h4>
              <div className="space-y-2">
                {event.materials.map((mat) => (
                  <div
                    key={mat.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-50 hover:bg-zinc-100 transition-colors group"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600 shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 truncate">
                        {mat.originalName || mat.fileName}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {formatFileSize(mat.fileSize)}
                        {mat.description && ` \u00B7 ${mat.description}`}
                      </p>
                    </div>
                    <a
                      href={mat.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recordings */}
          {event.recordings.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                Recordings ({event.recordings.length})
              </h4>
              <div className="space-y-2">
                {event.recordings.map((rec) => (
                  <div
                    key={rec.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-50 hover:bg-zinc-100 transition-colors group"
                  >
                    <div
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-lg shrink-0",
                        rec.playbackUrl
                          ? "bg-emerald-50 text-emerald-600"
                          : "bg-zinc-100 text-zinc-400",
                      )}
                    >
                      <Video className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 truncate">
                        {rec.title}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {formatDuration(rec.durationInMinutes)} &middot;{" "}
                        {formatDate(rec.recordedAt)}
                      </p>
                    </div>
                    {rec.playbackUrl ? (
                      <a
                        href={rec.playbackUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-emerald-600"
                        >
                          <Play className="w-4 h-4 mr-1" />
                          Watch
                        </Button>
                      </a>
                    ) : (
                      <span className="text-xs text-zinc-400 px-2">
                        Processing
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
