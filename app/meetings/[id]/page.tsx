"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { StreamCall, StreamTheme } from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";

import { useGetCallById } from "./hooks/useGetCallById";
import Alert from "./components/Alert";
import MeetingSetup from "./components/MeetingSetup";
import MeetingRoom from "./components/MeetingRoom";
import { useSession } from "next-auth/react";

const MeetingPage = () => {
  const { id } = useParams();
  const { data: session, status } = useSession();
  const { call, isCallLoading } = useGetCallById(id as string);
  const [isSetupComplete, setIsSetupComplete] = useState(false);

  if (status === "loading" || isCallLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Loading meeting...</p>
      </div>
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
