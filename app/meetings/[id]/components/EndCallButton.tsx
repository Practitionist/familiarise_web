"use client";

import { useState, useEffect, useCallback } from "react";
import {
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Loader2, PhoneOff } from "lucide-react";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";

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

  const endCall = useCallback(async () => {
    if (isEnding) return; // Prevent multiple calls

    setIsEnding(true);

    try {
      await call?.endCall();
    } catch (error) {
      // Navigating away regardless, so the failure is logged rather than
      // blocking the exit.
      console.error("Error ending call:", error);
    } finally {
      // Unconditional, and in `finally`: releasing the hardware used to sit
      // after `endCall()` in the same try, so an endCall that threw took the
      // camera release down with it and the host left the page still
      // broadcasting.
      await leaveCallAndReleaseMedia(call);
      setIsEnding(false);
      router.push(getDashboardUrl());
    }
  }, [call, isEnding, getDashboardUrl, router]);

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

  // Quiet by default and red only as the hold fills. It sits inside the
  // session menu now, so it no longer has to shout to be findable — and it no
  // longer competes with Leave for the eye.
  return (
    <Button
      onMouseDown={() => !isEnding && setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
      // Touch had no way to reach the hold at all, so the control was
      // unusable on a phone.
      onTouchStart={() => !isEnding && setIsPressed(true)}
      onTouchEnd={() => setIsPressed(false)}
      onTouchCancel={() => setIsPressed(false)}
      disabled={isEnding}
      className="relative w-full overflow-hidden border border-red-500/50 bg-transparent text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-70"
      style={{
        background: isEnding
          ? "rgba(185,28,28,1)"
          : `linear-gradient(to right, rgba(239,68,68,0.35) ${progress}%, transparent ${progress}%)`,
      }}
    >
      {isEnding ? (
        <span className="relative z-10 flex items-center gap-2 text-white">
          <Loader2 className="h-4 w-4 animate-spin" />
          Ending call...
        </span>
      ) : (
        <span className="relative z-10 flex items-center gap-2">
          <PhoneOff className="h-4 w-4" />
          {progress > 0 ? "Keep holding…" : "Hold to end for everyone"}
        </span>
      )}
    </Button>
  );
};

export default EndCallButton;
