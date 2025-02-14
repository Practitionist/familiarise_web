'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { VideoMeeting } from '@/components/ui/video-meeting';
import { useSession } from 'next-auth/react';

export default function MeetingRoom() {
  const { meetingId } = useParams();
  const { data: session } = useSession();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const getToken = async () => {
      if (!session?.user?.id) return;

      try {
        const response = await fetch('/api/meetings/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: session.user.id,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to get token');
        }

        const data = await response.json();
        setToken(data.token);
      } catch (error) {
        console.error('Error getting token:', error);
      }
    };

    getToken();
  }, [session?.user?.id]);

  if (!session?.user || !token) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-2">Loading meeting room...</h2>
          <p className="text-muted-foreground">Please wait while we set up your meeting.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full">
      <VideoMeeting
        apiKey={process.env.NEXT_PUBLIC_STREAM_API_KEY!}
        token={token}
        userId={session.user.id}
        callId={meetingId as string}
        username={session.user.name || 'Anonymous'}
      />
    </div>
  );
}
