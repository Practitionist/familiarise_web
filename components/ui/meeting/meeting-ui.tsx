'use client';

import { useEffect, useState } from "react";
import { StreamVideoParticipant, CallingState, useCallStateHooks } from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";
import FlexibleCallLayout from "./flexible-call-layout";
import SetupUI from "./setup-ui";

export default function MeetingUI() {
  const [setupComplete, setSetupComplete] = useState(false);
  const { useCallCallingState } = useCallStateHooks();
  const callingState = useCallCallingState();

  // Reset setup state when call state changes
  useEffect(() => {
    if (callingState === CallingState.LEFT) {
      setSetupComplete(false);
    }
  }, [callingState]);

  const { useCameraState, useMicrophoneState, useParticipants } = useCallStateHooks();
  const cameraState = useCameraState();
  const microphoneState = useMicrophoneState();
  const participants = useParticipants();

  useEffect(() => {
    // Enable camera and mic when joining the call
    const enableDevices = async () => {
      if (callingState === CallingState.JOINED) {
        try {
          // Only enable devices if we're not already publishing
          const isPublishing = participants.some((p: StreamVideoParticipant) => 
            p.isLocalParticipant && p.publishedTracks.length > 0
          );
          if (!isPublishing) {
            await cameraState.camera.enable();
            await microphoneState.microphone.enable();
          }
        } catch (error) {
          console.error('Error enabling devices:', error);
        }
      }
    };
    enableDevices();
  }, [callingState, cameraState, microphoneState, participants]);

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

  return (
    <div className="w-full h-[calc(100vh-80px)]">
      <FlexibleCallLayout />
    </div>
  );
}
