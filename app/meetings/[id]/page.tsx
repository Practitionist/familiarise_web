"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import {
  StreamCall,
  StreamTheme,
  CallingState,
} from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";

import { useGetCallById } from "./hooks/useGetCallById";
import Alert from "./components/Alert";
import MeetingSetup from "./components/MeetingSetup";
import MeetingRoom from "./components/MeetingRoom";
import { useSession } from "next-auth/react";

const MeetingPage = () => {
  const { id } = useParams();
  const { data: session, status } = useSession();
  const { call, isCallLoading, error } = useGetCallById(id as string);
  const [isSetupComplete, setIsSetupComplete] = useState(false);

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

  if (status === "loading" || isCallLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Loading meeting...</p>
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

  // Check if the user is allowed to join this meeting
  // This is a simple check - you might want to implement more complex permission logic
  const notAllowed = !session?.user;

  if (notAllowed) {
    return <Alert title="You need to be logged in to join this meeting" />;
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
