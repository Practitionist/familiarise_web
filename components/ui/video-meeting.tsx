'use client';

import {
  CallControls,
  SpeakerLayout,
  StreamTheme,
  StreamVideo,
  StreamVideoClient,
  useStreamVideoClient,
  useCallStateHooks
} from '@stream-io/video-react-sdk';
import '@stream-io/video-react-sdk/dist/css/styles.css';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const { toast } = useToast();

  const initClient = useCallback(async () => {
    try {
      if (client) return;

      const streamClient = new StreamVideoClient({
        apiKey,
        user: {
          id: userId,
          name: username,
          type: 'authenticated',
        },
        token,
      });

      setClient(streamClient);
    } catch (error) {
      console.error('Error initializing Stream client:', error);
      toast({
        title: 'Error',
        description: 'Failed to initialize video client',
        variant: 'destructive',
      });
    }
  }, [apiKey, token, userId, username, client]);

  useEffect(() => {
    initClient();

    return () => {
      if (client) {
        client.disconnectUser();
        setClient(null);
      }
    };
  }, [initClient, client]);

  if (!client) {
    return <div>Loading video meeting...</div>;
  }

  const VideoCallContent = () => {
    const videoClient = useStreamVideoClient();
    const [callState, setCallState] = useState<'joining' | 'joined' | 'error'>('joining');
    const callRef = useRef<any>(null);

    useEffect(() => {
      let isSubscribed = true;

      const setupCall = async () => {
        if (!videoClient) return;

        try {
          // Clean up any existing call
          if (callRef.current) {
            await callRef.current.leave();
            callRef.current = null;
          }

          // Create and join new call
          const newCall = videoClient.call('default', callId);
          await newCall.join({ create: true });
          
          if (isSubscribed) {
            callRef.current = newCall;
            setCallState('joined');
          }
        } catch (error) {
          console.error('Error joining call:', error);
          if (isSubscribed) {
            setCallState('error');
            toast({
              title: 'Error',
              description: 'Failed to join the meeting',
              variant: 'destructive',
            });
          }
        }
      };

      setupCall();

      return () => {
        isSubscribed = false;
        const cleanup = async () => {
          if (callRef.current) {
            try {
              await callRef.current.leave();
              callRef.current = null;
            } catch (error) {
              console.error('Error leaving call:', error);
            }
          }
        };
        cleanup();
      };
    }, [videoClient, callId]);

    if (callState === 'joining') {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-muted-foreground">Joining meeting...</p>
          </div>
        </div>
      );
    }

    if (callState === 'error') {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-red-600 mb-2">Failed to join meeting</h2>
            <p className="text-muted-foreground">Please try again later</p>
          </div>
        </div>
      );
    }

    return (
      <StreamTheme>
        <div className="h-full w-full flex flex-col">
          <div className="flex-grow relative">
            <div className="absolute inset-0">
              <SpeakerLayout />
            </div>
            <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10 bg-background/80 rounded-lg p-4 flex gap-4">
              <CallControls />
            </div>
          </div>
        </div>
      </StreamTheme>
    );
  };

  return (
    <StreamVideo client={client}>
      <VideoCallContent />
    </StreamVideo>
  );
}
