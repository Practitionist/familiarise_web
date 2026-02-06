"use client";

import { useState, useEffect } from "react";
import { useCall } from "@stream-io/video-react-sdk";
import { useSession } from "@/lib/auth-client";
import { Circle, Square, Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { useToast } from "@/hooks/use-toast";

interface RecordingControlsProps {
  meetingSessionId: string;
  recordingEnabled: boolean;
  showOnlyButton?: boolean;
  showOnlyIndicator?: boolean;
}

const RecordingControls = ({
  meetingSessionId,
  recordingEnabled,
  showOnlyButton = false,
  showOnlyIndicator = false,
}: RecordingControlsProps) => {
  const call = useCall();
  const { toast } = useToast();
  const { data: session } = useSession();
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // Only consultants (hosts) should be able to control recordings
  // Use session role instead of Stream's createdBy, as consultee might join first
  const isConsultant = session?.user?.role === "CONSULTANT";

  // Subscribe to call recording state changes
  useEffect(() => {
    if (!call) return;

    // Get initial recording state from call
    const checkRecordingState = () => {
      const callState = call.state;
      const recording = callState.recording;
      setIsRecording(!!recording);
    };

    checkRecordingState();

    // Listen for recording state changes
    const unsubscribe = call.on("call.recording_started", () => {
      setIsRecording(true);
      setIsLoading(false);
      toast({
        title: "Recording Started",
        description: "The session is now being recorded.",
      });
    });

    const unsubscribeStopped = call.on("call.recording_stopped", () => {
      setIsRecording(false);
      setIsLoading(false);
      setRecordingDuration(0);
      toast({
        title: "Recording Stopped",
        description: "The recording has been saved.",
      });
    });

    const unsubscribeFailed = call.on("call.recording_failed", () => {
      setIsRecording(false);
      setIsLoading(false);
      toast({
        title: "Recording Failed",
        description: "There was an error with the recording.",
        variant: "destructive",
      });
    });

    // Also subscribe to general call state updates to catch recording changes
    const unsubscribeUpdated = call.on("call.updated", () => {
      const recording = call.state.recording;
      if (recording && !isRecording) {
        setIsRecording(true);
        setIsLoading(false);
      } else if (!recording && isRecording) {
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
  }, [call, toast, isRecording]);

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

  // Format duration as MM:SS or HH:MM:SS
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
          streamCallId: call.id,
          meetingSessionId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to start recording");
      }

      // The recording state will be updated via call events
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
          streamCallId: call.id,
          meetingSessionId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to stop recording");
      }

      // The recording state will be updated via call events
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

  // For non-consultants (consultees), show recording indicator when recording is active
  if (!isConsultant) {
    // Show recording indicator when recording is active (so consultee knows they're being recorded)
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

  // For consultants - render based on props

  // If showOnlyIndicator is true, only render the REC time indicator (when recording)
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
