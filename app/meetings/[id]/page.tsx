"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import {
  StreamCall,
  StreamTheme,
  CallingState,
} from "@stream-io/video-react-sdk";
import { Loader2, ShieldAlert } from "lucide-react";

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

  // Cleanup on component unmount - disable media streams before leaving
  useEffect(() => {
    return () => {
      console.log("Meeting page unmounting, cleaning up call...");

      const cleanup = async () => {
        try {
          // Disable media streams first to stop audio/video
          await call?.camera.disable();
          await call?.microphone.disable();

          // Disable screen share if active
          if (call?.screenShare?.state?.status === "enabled") {
            await call?.screenShare.disable();
          }

          console.log("Media streams disabled");

          // Leave the call if still connected
          if (call?.state.callingState !== CallingState.LEFT) {
            console.log("Leaving call on unmount");
            await call?.leave();
          }
        } catch (error) {
          console.warn("Error during cleanup on unmount:", error);
        }
      };

      cleanup();
    };
  }, [call]);

  // Loading states
  if (isSessionPending || isValidatingAccess || isCallLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
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
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50">
        <div className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
            <ShieldAlert className="w-8 h-8 text-red-600" />
          </div>
          <h2 className="text-xl font-bold text-zinc-900 mb-2">
            Access Denied
          </h2>
          <p className="text-zinc-600 mb-4">{accessValidation.message}</p>
          <p className="text-sm text-zinc-500">
            If you believe this is an error, please contact support or the
            meeting host.
          </p>
          <button
            onClick={() => window.history.back()}
            className="mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
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
