"use client";

import Button from "./components/button";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function MeetingsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [meetingId, setMeetingId] = useState("");
  const [description, setDescription] = useState("");

  const createMeeting = () => {
    // Generate a random meeting ID if none is provided
    const newMeetingId = meetingId || Math.random().toString(36).substring(7);
    router.push(`/meetings/${newMeetingId}`);
  };

  if (!session?.user) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-2">Please sign in</h2>
          <p className="text-muted-foreground">
            You need to be signed in to create or join meetings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10">
      <div className="max-w-md mx-auto space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold mb-2">Create a Meeting</h1>
          <p className="text-muted-foreground">
            Start a new video meeting or join an existing one
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="meetingId" className="text-sm font-medium">
              Meeting ID (optional)
            </label>
            <input
              id="meetingId"
              type="text"
              placeholder="Enter meeting ID or leave blank for random"
              className="w-full px-3 py-2 border rounded-md"
              value={meetingId}
              onChange={(e) => setMeetingId(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="description" className="text-sm font-medium">
              Description (optional)
            </label>
            <textarea
              id="description"
              placeholder="Meeting description"
              className="w-full px-3 py-2 border rounded-md"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <Button onClick={createMeeting} className="w-full">
            Start Meeting
          </Button>
        </div>
      </div>
    </div>
  );
}
