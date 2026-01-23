"use client";

import { useState, useEffect } from "react";
import { useCall, useCallStateHooks } from "@stream-io/video-react-sdk";
import { Circle, Square, Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { useToast } from "@/hooks/use-toast";

interface RecordingControlsProps {
  meetingSessionId: string;
  recordingEnabled: boolean;
}

const RecordingControls = ({
  meetingSessionId,
  recordingEnabled,
}: RecordingControlsProps) => {
  const call = useCall();
  const { toast } = useToast();
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const { useLocalParticipant } = useCallStateHooks();
  const localParticipant = useLocalParticipant();

  // Check if user is the call owner (consultant)
  const isCallOwner =
    localParticipant &&
    call?.state.createdBy &&
    localParticipant.userId === call.state.createdBy.id;

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

    return () => {
      unsubscribe();
      unsubscribeStopped();
      unsubscribeFailed();
    };
  }, [call, toast]);

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

  // Don't render if recording is not enabled for this session
  if (!recordingEnabled) {
    return null;
  }

  // Only show controls to call owner (consultant)
  // But show recording indicator to everyone
  if (!isCallOwner) {
    // Recording indicator for non-owners when recording is active
    if (isRecording) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-500/20 rounded-lg border border-red-500/30">
          <Circle className="w-3 h-3 fill-red-500 text-red-500 animate-pulse" />
          <span className="text-sm font-medium text-red-400">
            Recording {formatDuration(recordingDuration)}
          </span>
        </div>
      );
    }
    return null;
  }

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
          "p-3 rounded-xl transition-all duration-200 flex items-center gap-2",
          isRecording
            ? "bg-red-500 hover:bg-red-600 text-white"
            : "bg-zinc-800 hover:bg-zinc-700 text-white",
          isLoading && "opacity-50 cursor-not-allowed",
        )}
        title={isRecording ? "Stop Recording" : "Start Recording"}
      >
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : isRecording ? (
          <Square className="w-5 h-5 fill-current" />
        ) : (
          <Circle className="w-5 h-5 fill-red-500 text-red-500" />
        )}
      </button>
    </div>
  );
};

export default RecordingControls;
