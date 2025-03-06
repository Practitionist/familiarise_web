"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export default function MeetingPage() {
  const params = useParams();
  const router = useRouter();
  const client = useStreamVideoClient();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const meetingId = params.id as string;

  useEffect(() => {
    const joinMeeting = async () => {
      if (!client) {
        setError("Video client not initialized. Please try again.");
        setLoading(false);
        return;
      }

      try {
        // Get the call
        const call = client.call("default", meetingId);

        if (!call) {
          setError(
            "Failed to find the meeting. It may have ended or been cancelled.",
          );
          setLoading(false);
          return;
        }

        // Join the call
        await call.getOrCreate();
        await call.join({ create: true });

        // Redirect to the call UI
        // This is a placeholder - you'll need to implement the actual call UI
        setLoading(false);
      } catch (err: any) {
        console.error("Error joining meeting:", err);
        setError(err.message || "Failed to join meeting. Please try again.");
        setLoading(false);
      }
    };

    if (client) {
      joinMeeting();
    }
  }, [client, meetingId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Joining meeting...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
          <h1 className="text-xl font-semibold text-red-700 mb-4">
            Error Joining Meeting
          </h1>
          <p className="text-gray-700 mb-6">{error}</p>
          <Button onClick={() => router.back()}>Go Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <div className="bg-white border rounded-lg p-6 max-w-md">
        <h1 className="text-xl font-semibold mb-4">Meeting: {meetingId}</h1>
        <p className="text-gray-700 mb-6">
          You&apos;ve successfully joined the meeting. The video interface will
          appear here.
        </p>
        <div className="flex space-x-4">
          <Button onClick={() => router.back()} variant="outline">
            Leave Meeting
          </Button>
        </div>
      </div>
    </div>
  );
}
