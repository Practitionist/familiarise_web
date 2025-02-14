'use client';

import AudioVolumeIndicator from "@/components/ui/meeting/audio-volume-indicator";
import Button from "@/components/ui/meeting/button";
import FlexibleCallLayout from "@/components/ui/meeting/flexible-call-layout";
import PermissionPrompt from "@/components/ui/meeting/permission-prompt";
import { useSession } from "next-auth/react";
import {
  CallingState,
  DeviceSettings,
  StreamCall,
  StreamVideo,
  StreamVideoClient,
  VideoPreview,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";
import React, { useEffect, useState } from "react";

interface MeetingPageProps {
  params: Promise<{
    meetingId: string;
  }>;
}

export default function MeetingPage({ params }: Readonly<MeetingPageProps>) {
  const { meetingId } = React.use(params);
  const { data: session } = useSession();
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<any>(null);

  useEffect(() => {
    if (!session?.user?.id) return;

    const initClient = async () => {
      try {
        // Get token from our API
        const response = await fetch('/api/meetings/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: session.user.id }),
        });

        if (!response.ok) throw new Error('Failed to get token');

        const { token } = await response.json();

        const user = {
          id: session.user.id,
          name: session.user.name ?? session.user.id,
          type: 'authenticated' as const,
        };

        // Initialize Stream client
        const streamClient = new StreamVideoClient(process.env.NEXT_PUBLIC_STREAM_API_KEY!, {
          logLevel: 'info',
        });

        // Connect user
        await streamClient.connectUser(user, token);

        setClient(streamClient);

        // Create and join call
        const call = streamClient.call('default', meetingId);
        await call.join({ create: true });
        setCall(call);
      } catch (error) {
        console.error('Error initializing meeting:', error);
      }
    };

    initClient();

    return () => {
      if (call) {
        call.leave();
      }
      if (client) {
        client.disconnectUser();
      }
    };
  }, [session?.user, meetingId]);

  if (!session?.user || !client || !call) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <MeetingUI />
      </StreamCall>
    </StreamVideo>
  );
}

interface SetupUIProps {
  onSetupComplete: () => void;
}

function SetupUI({ onSetupComplete }: Readonly<SetupUIProps>) {
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();
  const [micCamDisabled, setMicCamDisabled] = useState(false);

  useEffect(() => {
    if (micCamDisabled) {
      micState.microphone.disable();
      camState.camera.disable();
    } else {
      micState.microphone.enable();
      camState.camera.enable();
    }
  }, [micCamDisabled, micState, camState]);

  if (!micState.hasBrowserPermission || !camState.hasBrowserPermission) {
    return <PermissionPrompt />;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <h1 className="text-2xl font-bold">Setup</h1>
      <VideoPreview />
      <div className="flex h-16 items-center gap-3">
        <AudioVolumeIndicator />
        <DeviceSettings />
      </div>
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={micCamDisabled}
          onChange={(e) => setMicCamDisabled(e.target.checked)}
        />
        Join with mic and camera off
      </label>
      <Button onClick={onSetupComplete}>Join meeting</Button>
    </div>
  );
}

function MeetingUI() {
  const [setupComplete, setSetupComplete] = useState(false);
  const { useCallCallingState } = useCallStateHooks();
  const callingState = useCallCallingState();

  if (!setupComplete) {
    return <SetupUI onSetupComplete={() => setSetupComplete(true)} />;
  }

  if (callingState !== CallingState.JOINED) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return <FlexibleCallLayout />;
}
