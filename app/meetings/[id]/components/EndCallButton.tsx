"use client";

import { useState, useEffect, useCallback } from "react";
import {
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Loader2 } from "lucide-react";

const EndCallButton = () => {
  const call = useCall();
  const { useCallCustomData } = useCallStateHooks();
  const custom = useCallCustomData();
  const router = useRouter();
  const { data: session } = useSession();
  const [isPressed, setIsPressed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isEnding, setIsEnding] = useState(false);

  // Get proper dashboard URL based on user role and profile
  const getDashboardUrl = useCallback(() => {
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
  }, [session]);

  // Cleanup media streams and WebRTC connections
  const cleanupMediaStreams = useCallback(async () => {
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
  }, [call]);

  const endCall = useCallback(async () => {
    if (isEnding) return; // Prevent multiple calls

    setIsEnding(true);

    try {
      console.log("Starting call cleanup process...");

      // 1. End the call for everyone
      await call?.endCall();
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
  }, [call, isEnding, cleanupMediaStreams, getDashboardUrl, router]);

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
  }, [isPressed, endCall]);

  if (!call)
    throw new Error(
      "useStreamCall must be used within a StreamCall component.",
    );

  // Only the host (delivering side) may end the call for everyone.
  // #org-appts — derive the host from WHICH SIDE of THIS appointment the viewer
  // is on (the consultantUserId stamped into the call), not the singular
  // UserRole: a dual-profile user booked as a learner into someone else's
  // session has role CONSULTANT but is the guest here. Fall back to the role
  // check for legacy calls created before the id was stamped.
  const consultantUserId = custom?.consultantUserId as string | undefined;
  const isHost = consultantUserId
    ? session?.user?.id === consultantUserId
    : session?.user?.role === "CONSULTANT";

  if (!isHost) return null;

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
