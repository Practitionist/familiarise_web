"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import {
  CALL_RESOLUTIONS,
  RECORDING_QUALITIES,
  SCREENSHARE_RESOLUTIONS,
  VIDEO_COST_HINTS,
  type PlatformVideoConfig,
} from "@/lib/stream/video-quality";

const QUERY_KEY = ["admin-video-config"];

interface FieldProps<T extends string> {
  id: string;
  label: string;
  options: readonly T[];
  value: T;
  hints: Record<T, string>;
  onChange: (value: T) => void;
}

function QualityField<T extends string>({
  id,
  label,
  options,
  value,
  hints,
  onChange,
}: Readonly<FieldProps<T>>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          const match = options.find((option) => option === next);
          if (match) onChange(match);
        }}
      >
        <SelectTrigger id={id} className="max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">{hints[value]}</p>
    </div>
  );
}

export default function VideoConfigPageClient() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/video-config");
      if (!res.ok) throw new Error("Failed to load video quality settings");
      const json = (await res.json()) as { config: PlatformVideoConfig };
      return json.config;
    },
  });

  const [draft, setDraft] = useState<PlatformVideoConfig | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: async (payload: PlatformVideoConfig & { reason: string }) => {
      const res = await fetch("/api/admin/video-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to update video quality");
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setReason("");
      setError(null);
      setMessage("Video quality updated. New and reopened calls use it.");
    },
    onError: (err: Error) => {
      setMessage(null);
      setError(err.message);
    },
  });

  const current = query.data;
  const dirty =
    !!current &&
    !!draft &&
    (draft.callTargetResolution !== current.callTargetResolution ||
      draft.recordingQuality !== current.recordingQuality ||
      draft.screenshareTargetResolution !==
        current.screenshareTargetResolution);

  return (
    <>
      <DashboardHeader
        title="Video quality"
        subtitle="Call, screen-share and recording quality applied when a call is created or reopened. Calls already running keep their quality."
      />
      <DashboardContent>
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle className="text-base">Quality and cost</CardTitle>
            <CardDescription>
              Higher quality raises Stream&apos;s per-minute bill. Defaults are
              720p calls, 720p recordings and 1080p screen share. Stream
              recording tops out at 1440p and 4K is not offered.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {query.isError && (
              <p className="text-sm text-destructive">
                Could not load the current settings.
              </p>
            )}
            {draft && (
              <>
                <QualityField
                  id="call-resolution"
                  label="Call video"
                  options={CALL_RESOLUTIONS}
                  value={draft.callTargetResolution}
                  hints={VIDEO_COST_HINTS.call}
                  onChange={(callTargetResolution) =>
                    setDraft({ ...draft, callTargetResolution })
                  }
                />
                <QualityField
                  id="screenshare-resolution"
                  label="Screen share"
                  options={SCREENSHARE_RESOLUTIONS}
                  value={draft.screenshareTargetResolution}
                  hints={VIDEO_COST_HINTS.screenshare}
                  onChange={(screenshareTargetResolution) =>
                    setDraft({ ...draft, screenshareTargetResolution })
                  }
                />
                <QualityField
                  id="recording-quality"
                  label="Recording"
                  options={RECORDING_QUALITIES}
                  value={draft.recordingQuality}
                  hints={VIDEO_COST_HINTS.recording}
                  onChange={(recordingQuality) =>
                    setDraft({ ...draft, recordingQuality })
                  }
                />
                <div className="space-y-2">
                  <Label htmlFor="video-config-reason">Reason</Label>
                  <Input
                    id="video-config-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Why are you changing this? (recorded in the audit log)"
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                {message && (
                  <p className="text-sm text-muted-foreground">{message}</p>
                )}
                <Button
                  disabled={
                    !dirty || reason.trim().length < 5 || save.isPending
                  }
                  onClick={() => {
                    setMessage(null);
                    setError(null);
                    save.mutate({ ...draft, reason: reason.trim() });
                  }}
                >
                  Save
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
