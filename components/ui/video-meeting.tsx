'use client';

import { useEffect, useState } from 'react';
import {
  StreamVideo,
  StreamVideoClient,
  User,
  Call,
  CallControls,
  SpeakerLayout,
  StreamTheme,
} from '@stream-io/video-react-sdk';
import '@stream-io/video-react-sdk/dist/css/styles.css';
import { useToast } from './use-toast';

interface VideoMeetingProps {
  apiKey: string;
  token: string;
  userId: string;
  callId: string;
  username: string;
}

export function VideoMeeting({ apiKey, token, userId, callId, username }: Readonly<VideoMeetingProps>) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    // Define error handler outside try block
    const handleConnectionError = () => {
      toast({
        title: 'Connection Error',
        description: 'Failed to establish WebSocket connection. Please try again.',
        variant: 'destructive',
      });
    };

    const initClient = async () => {
      try {
        // Create user object
        const user: User = {
          id: userId,
          name: username,
          type: 'authenticated',
        };

        // Initialize client with proper configuration
        const streamClient = new StreamVideoClient(apiKey);

        // Connect user first
        await streamClient.connectUser(user, token);
        setClient(streamClient);

        // Then create and join call
        const newCall = streamClient.call('default', callId);
        await newCall.join({ create: true });
        setCall(newCall);

        // Add error handling for WebSocket connection
        streamClient.on('connection.error', handleConnectionError);
      } catch (error) {
        console.error('Error initializing Stream client:', error);
        toast({
          title: 'Error',
          description: 'Failed to connect to video meeting',
          variant: 'destructive',
        });
      }
    };

    initClient();

    return () => {
      const cleanup = async () => {
        try {
          if (call) {
            await call.leave();
          }
          if (client) {
            client.off('connection.error', handleConnectionError);
            await client.disconnectUser();
          }
        } catch (error) {
          console.error('Error during cleanup:', error);
        }
      };
      cleanup();
    };
  }, [apiKey, token, userId, callId, username]);

  if (!client || !call) {
    return <div>Loading video meeting...</div>;
  }

  return (
    <StreamVideo client={client}>
      <StreamTheme>
        <div className="h-full w-full flex flex-col">
          <div className="flex-grow">
            <SpeakerLayout />
          </div>
          <div className="p-4 bg-background">
            <CallControls />
          </div>
        </div>
      </StreamTheme>
    </StreamVideo>
  );
}
