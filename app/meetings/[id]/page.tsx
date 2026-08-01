"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { StreamCall, StreamTheme } from "@stream-io/video-react-sdk";
import { Loader2, ShieldAlert } from "lucide-react";

import {
  leaveCallAndReleaseMedia,
  stopLocalTracks,
} from "@/lib/stream/media-teardown";
import { useGetCallById } from "./hooks/useGetCallById";
import Alert from "./components/Alert";
import MeetingSetup from "./components/MeetingSetup";
import MeetingRoom from "./components/MeetingRoom";
import { useSession } from "@/lib/auth-client";

interface AccessValidation {
  hasAccess: boolean;
  role: "host" | "participant" | null;
  message: string;
}

const MeetingPage = () => {
  const { id } = useParams();
  const { data: session, isPending: isSessionPending } = useSession();
  const { call, isCallLoading, error } = useGetCallById(id as string);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [accessValidation, setAccessValidation] =
    useState<AccessValidation | null>(null);
  const [isValidatingAccess, setIsValidatingAccess] = useState(true);

  // Validate meeting access
  useEffect(() => {
    const validateAccess = async () => {
      if (!id || !session?.user?.id) {
        setIsValidatingAccess(false);
        return;
      }

      try {
        const response = await fetch(`/api/meetings/${id}/validate-access`);
        const data = await response.json();
        setAccessValidation(data);
      } catch (err) {
        console.error("Error validating meeting access:", err);
        setAccessValidation({
          hasAccess: false,
          role: null,
          message: "Failed to validate access. Please try again.",
        });
      } finally {
        setIsValidatingAccess(false);
      }
    };

    if (session?.user?.id) {
      validateAccess();
    } else if (!isSessionPending) {
      setIsValidatingAccess(false);
    }
  }, [id, session?.user?.id, isSessionPending]);

  // Release the camera and microphone on ANY exit from this page, not just the
  // explicit Leave button: navigating away and the browser Back button both
  // unmount the route, and until this ran on those paths too the capture light
  // stayed on after the user had visibly left the meeting.
  useEffect(() => {
    if (!call) return;

    // React does not run effect cleanup when the document itself goes away
    // (tab close, hard navigation), so the tracks are stopped from `pagehide`
    // too. Synchronously: anything awaited here may never resume. Leaving the
    // call properly is skipped — Stream times the participant out, and the
    // camera going dark is the part that cannot wait.
    const onPageHide = () => {
      stopLocalTracks(call);
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void leaveCallAndReleaseMedia(call);
    };
  }, [call]);

  // Loading states
  if (isSessionPending || isValidatingAccess || isCallLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">
          {isSessionPending
            ? "Checking authentication..."
            : isValidatingAccess
              ? "Validating access..."
              : "Loading meeting..."}
        </p>
      </div>
    );
  }

  // Not logged in
  if (!session?.user) {
    return <Alert title="You need to be logged in to join this meeting" />;
  }

  // Access denied
  if (accessValidation && !accessValidation.hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-muted p-4">
        <div className="w-full max-w-md bg-card p-8 rounded-2xl shadow-xl border border-border text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
            <ShieldAlert className="w-8 h-8 text-red-600" />
          </div>
          <h2 className="text-xl font-bold text-foreground mb-2">
            Access Denied
          </h2>
          <p className="text-muted-foreground mb-4">{accessValidation.message}</p>
          <p className="text-sm text-muted-foreground/70">
            If you believe this is an error, please contact support or the
            meeting host.
          </p>
          <button
            onClick={() => window.history.back()}
            className="mt-6 px-6 py-2.5 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        title="Meeting Error"
        description={`Failed to load meeting: ${error.message}`}
      />
    );
  }

  if (!call) {
    return (
      <Alert
        title="Meeting Not Found"
        description="The meeting you're trying to join doesn't exist or has ended."
      />
    );
  }

  return (
    <main className="h-screen w-full">
      <StreamCall call={call}>
        <StreamTheme>
          {!isSetupComplete ? (
            <MeetingSetup setIsSetupComplete={setIsSetupComplete} />
          ) : (
            <MeetingRoom />
          )}
        </StreamTheme>
      </StreamCall>
    </main>
  );
};

export default MeetingPage;
