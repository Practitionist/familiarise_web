"use client";

import { useState, useEffect, useRef } from "react";
import { useCall } from "@stream-io/video-react-sdk";
import { Circle, Square, Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { useToast } from "@/hooks/use-toast";
import { useSessionInfo } from "../session-info";

interface RecordingControlsProps {
  meetingId: string;
  recordingEnabled: boolean;
  showOnlyButton?: boolean;
  showOnlyIndicator?: boolean;
  isHost?: boolean;
}

const RecordingControls = ({
  meetingId,
  recordingEnabled: _recordingEnabled,
  showOnlyButton = false,
  showOnlyIndicator = false,
  isHost: isHostProp,
}: RecordingControlsProps) => {
  const call = useCall();
  const { toast } = useToast();
  const { isHost: sessionIsHost } = useSessionInfo();
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // Derive host control from call metadata (`useSessionInfo`) so org experts and co-presenters can record.
  const isHost = isHostProp ?? sessionIsHost;

  // Ref to avoid stale closure in call event handlers
  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // The host mounts a button-only and an indicator copy; only one may announce.
  const announces = !showOnlyButton;

  // Subscribe to call recording state changes
  useEffect(() => {
    if (!call) return;

    const checkRecordingState = () => {
      const callState = call.state;
      const recording = callState.recording;
      setIsRecording(!!recording);
    };

    checkRecordingState();

    const unsubscribe = call.on("call.recording_started", () => {
      setIsRecording(true);
      setIsLoading(false);
      if (announces)
        toast({
          title: "Recording Started",
          description: "The session is now being recorded.",
        });
    });

    const unsubscribeStopped = call.on("call.recording_stopped", () => {
      setIsRecording(false);
      setIsLoading(false);
      setRecordingDuration(0);
      if (announces)
        toast({
          title: "Recording Stopped",
          description: "It will appear in Recordings shortly.",
        });
    });

    const unsubscribeFailed = call.on("call.recording_failed", () => {
      setIsRecording(false);
      setIsLoading(false);
      if (announces)
        toast({
          title: "Recording Failed",
          description: "There was an error with the recording.",
          variant: "destructive",
        });
    });

    const unsubscribeUpdated = call.on("call.updated", () => {
      const recording = call.state.recording;
      if (recording && !isRecordingRef.current) {
        setIsRecording(true);
        setIsLoading(false);
      } else if (!recording && isRecordingRef.current) {
        setIsRecording(false);
        setIsLoading(false);
        setRecordingDuration(0);
      }
    });

    return () => {
      unsubscribe();
      unsubscribeStopped();
      unsubscribeFailed();
      unsubscribeUpdated();
    };
  }, [call, toast, announces]);

  // Recording duration timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    if (isRecording) {
      interval = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleStartRecording = async () => {
    if (!call || isLoading) return;

    setIsLoading(true);

    try {
      const response = await fetch("/api/stream/recordings/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          meetingId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to start recording");
      }
    } catch (error) {
      console.error("Error starting recording:", error);
      setIsLoading(false);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to start recording",
        variant: "destructive",
      });
    }
  };

  const handleStopRecording = async () => {
    if (!call || isLoading) return;

    setIsLoading(true);

    try {
      const response = await fetch("/api/stream/recordings/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          meetingId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to stop recording");
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
      setIsLoading(false);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to stop recording",
        variant: "destructive",
      });
    }
  };

  if (!isHost) {
    if (isRecording) {
      return (
        <div
          className="flex items-center gap-2 px-3 py-2 bg-red-500/20 rounded-lg border border-red-500/30 cursor-not-allowed"
          title="Recording in progress"
        >
          <Circle className="w-3 h-3 fill-red-500 text-red-500 animate-pulse" />
          <span className="text-sm font-medium text-red-400">
            REC {formatDuration(recordingDuration)}
          </span>
        </div>
      );
    }
    return null;
  }

  if (showOnlyIndicator) {
    if (!isRecording) return null;
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-red-500/20 rounded-lg border border-red-500/30">
        <Circle className="w-3 h-3 fill-red-500 text-red-500 animate-pulse" />
        <span className="text-sm font-medium text-red-400">
          REC {formatDuration(recordingDuration)}
        </span>
      </div>
    );
  }

  // If showOnlyButton is true, only render the recording button
  if (showOnlyButton) {
    return (
      <button
        onClick={isRecording ? handleStopRecording : handleStartRecording}
        disabled={isLoading}
        className={cn(
          "w-[46px] h-[46px] rounded-full transition-all duration-200 flex items-center justify-center",
          "bg-zinc-800 hover:bg-zinc-700",
          isLoading && "opacity-50 cursor-not-allowed",
        )}
        title={isRecording ? "Stop Recording" : "Start Recording"}
      >
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-white" />
        ) : isRecording ? (
          <Square className="w-4 h-4 fill-red-500 text-red-500" />
        ) : (
          <div className="w-4 h-4 rounded-full bg-red-500" />
        )}
      </button>
    );
  }

  // Default: render both button and indicator together
  return (
    <div className="flex items-center gap-2">
      {/* Recording indicator when active */}
      {isRecording && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-500/20 rounded-lg border border-red-500/30 mr-1">
          <Circle className="w-3 h-3 fill-red-500 text-red-500 animate-pulse" />
          <span className="text-sm font-medium text-red-400">
            {formatDuration(recordingDuration)}
          </span>
        </div>
      )}

      {/* Recording control button */}
      <button
        onClick={isRecording ? handleStopRecording : handleStartRecording}
        disabled={isLoading}
        className={cn(
          "p-3 rounded-full transition-all duration-200 flex items-center justify-center",
          "bg-zinc-800 hover:bg-zinc-700",
          isLoading && "opacity-50 cursor-not-allowed",
        )}
        title={isRecording ? "Stop Recording" : "Start Recording"}
      >
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-white" />
        ) : isRecording ? (
          <Square className="w-4 h-4 fill-red-500 text-red-500" />
        ) : (
          <div className="w-4 h-4 rounded-full bg-red-500" />
        )}
      </button>
    </div>
  );
};

export default RecordingControls;
