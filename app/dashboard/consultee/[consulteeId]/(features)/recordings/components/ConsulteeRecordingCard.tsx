"use client";

import { format } from "date-fns";
import { Play, Clock, Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface ConsulteeRecordingData {
  id: string;
  title: string;
  durationInMinutes: number;
  recordedAt: string;
  status: string;
  storageType: string;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  resolution: string | null;
  planType: "webinar" | "class" | null;
  planId: string | null;
  planTitle: string | null;
  createdAt: string;
}

interface ConsulteeRecordingCardProps {
  recording: ConsulteeRecordingData;
}

export function ConsulteeRecordingCard({ recording }: ConsulteeRecordingCardProps) {
  const formatDuration = (minutes: number) => {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    return `${mins}m`;
  };

  return (
    <Card className="overflow-hidden hover:shadow-lg transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg truncate">{recording.title}</CardTitle>
            {recording.planTitle && (
              <p className="text-sm text-muted-foreground mt-1">
                {recording.planType === "webinar" ? "Webinar" : "Class"}:{" "}
                {recording.planTitle}
              </p>
            )}
          </div>
          <Badge variant="secondary">
            {recording.planType === "webinar" ? "Webinar" : "Class"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Thumbnail or placeholder */}
        <div className="relative aspect-video bg-muted rounded-lg overflow-hidden group">
          {recording.thumbnailUrl ? (
            <img
              src={recording.thumbnailUrl}
              alt={recording.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
              <Play className="w-12 h-12 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
            </div>
          )}
          {/* Duration overlay */}
          <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/80 rounded text-xs text-white font-medium">
            {formatDuration(recording.durationInMinutes)}
          </div>
          {/* Play overlay on hover */}
          {recording.playbackUrl && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center">
                <Play className="w-8 h-8 text-white fill-white" />
              </div>
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-1">
            <Calendar className="w-4 h-4" />
            <span>{format(new Date(recording.recordedAt), "MMM d, yyyy")}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            <span>{format(new Date(recording.recordedAt), "h:mm a")}</span>
          </div>
          {recording.resolution && (
            <span className="text-xs bg-muted px-2 py-0.5 rounded">
              {recording.resolution}
            </span>
          )}
        </div>

        {/* Watch button */}
        {recording.playbackUrl && (
          <Button
            className="w-full"
            onClick={() => window.open(recording.playbackUrl!, "_blank")}
          >
            <Play className="w-4 h-4 mr-2" />
            Watch Recording
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default ConsulteeRecordingCard;
