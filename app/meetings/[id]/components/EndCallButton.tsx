"use client";

import { useState, useEffect } from "react";
import {
  useCall,
  useCallStateHooks,
  CallingState,
} from "@stream-io/video-react-sdk";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";

const EndCallButton = () => {
  const call = useCall();
  const router = useRouter();
  const { data: session } = useSession();
  const [isPressed, setIsPressed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isEnding, setIsEnding] = useState(false);

  useEffect(() => {
    let interval: number;
    if (isPressed) {
      interval = window.setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            clearInterval(interval);
            endCall();
            return 100;
          }
          return prev + 100 / (5000 / 50); // 5 second duration with 50ms intervals
        });
      }, 50);
    }
    return () => {
      if (interval) clearInterval(interval);
      if (!isPressed) setProgress(0);
    };
  }, [isPressed]);

  if (!call)
    throw new Error(
      "useStreamCall must be used within a StreamCall component.",
    );

  // https://getstream.io/video/docs/react/guides/call-and-participant-state/#participant-state-3
  const { useLocalParticipant } = useCallStateHooks();
  const localParticipant = useLocalParticipant();

  const isMeetingOwner =
    localParticipant &&
    call.state.createdBy &&
    localParticipant.userId === call.state.createdBy.id;

  if (!isMeetingOwner) return null;

  // Get proper dashboard URL based on user role and profile
  const getDashboardUrl = () => {
    if (!session?.user) return "/";

    const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
      session.user;

    if (role === "CONSULTANT" && consultantProfileId) {
      return `/dashboard/consultant/${consultantProfileId}/home`;
    }
    if (role === "CONSULTEE" && consulteeProfileId) {
      return `/dashboard/consultee/${consulteeProfileId}/home`;
    }
    if (role === "STAFF" && staffProfileId) {
      return `/dashboard/staff/${staffProfileId}/home`;
    }

    return "/"; // Fallback to home page
  };

  // Cleanup media streams and WebRTC connections
  const cleanupMediaStreams = async () => {
    try {
      // Stop camera and microphone
      await call?.camera.disable();
      await call?.microphone.disable();

      // Stop screen sharing if active (check via call state)
      if (call?.screenShare.state.status === "enabled") {
        await call?.screenShare.disable();
      }

      console.log("Media streams disabled successfully");
    } catch (error) {
      console.warn("Error cleaning up media streams:", error);
    }
  };

  const endCall = async () => {
    if (isEnding) return; // Prevent multiple calls

    setIsEnding(true);

    try {
      console.log("Starting call cleanup process...");

      // 1. End the call for everyone
      await call.endCall();
      console.log("Call ended successfully");

      // 2. Clean up media streams
      await cleanupMediaStreams();
      console.log("Media streams cleaned up");

      // 3. Small delay to ensure cleanup completes
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 4. Navigate to appropriate dashboard
      const dashboardUrl = getDashboardUrl();
      console.log("Redirecting to:", dashboardUrl);
      router.push(dashboardUrl);
    } catch (error) {
      console.error("Error ending call:", error);
      // Still try to navigate even if there was an error
      const dashboardUrl = getDashboardUrl();
      router.push(dashboardUrl);
    } finally {
      setIsEnding(false);
    }
  };

  return (
    <Button
      onMouseDown={() => !isEnding && setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
      disabled={isEnding}
      className="relative overflow-hidden bg-red-500 transition-colors disabled:opacity-70"
      style={{
        background: isEnding
          ? "rgba(185,28,28,1)"
          : `linear-gradient(to right, rgba(239,68,68,1) ${progress}%, rgba(185,28,28,1) ${progress}%)`,
      }}
    >
      {isEnding ? (
        <span className="relative z-10 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Ending call...
        </span>
      ) : (
        <span className="relative z-10">End call for everyone</span>
      )}
    </Button>
  );
};

export default EndCallButton;
