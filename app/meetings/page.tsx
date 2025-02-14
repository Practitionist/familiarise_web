'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export default function MeetingsPage() {
  const router = useRouter();
  const [meetingId, setMeetingId] = useState('');

  const createMeeting = () => {
    // Generate a random meeting ID if none is provided
    const newMeetingId = meetingId || Math.random().toString(36).substring(7);
    router.push(`/meetings/${newMeetingId}`);
  };

  return (
    <div className="container mx-auto py-32">
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

          <Button 
            onClick={createMeeting}
            className="w-full"
          >
            Start Meeting
          </Button>
        </div>
      </div>
    </div>
  );
}
