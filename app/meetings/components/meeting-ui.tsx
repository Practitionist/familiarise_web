"use client";

import { useEffect, useState } from "react";
import {
  StreamVideoParticipant,
  CallingState,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import FlexibleCallLayout from "./flexible-call-layout";
import SetupUI from "./setup-ui";

export default function MeetingUI() {
  const [setupComplete, setSetupComplete] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const { useCallCallingState } = useCallStateHooks();
  const callingState = useCallCallingState();
  const { toast } = useToast();

  // Reset setup state when call state changes
  useEffect(() => {
    if (callingState === CallingState.LEFT) {
      setSetupComplete(false);
    }
  }, [callingState]);

  const { useCameraState, useMicrophoneState, useParticipants } =
    useCallStateHooks();
  const cameraState = useCameraState();
  const microphoneState = useMicrophoneState();
  const participants = useParticipants();

  useEffect(() => {
    // Enable camera and mic when joining the call
    const enableDevices = async () => {
      if (callingState === CallingState.JOINED) {
        try {
          // Only enable devices if we're not already publishing
          const isPublishing = participants.some(
            (p: StreamVideoParticipant) =>
              p.isLocalParticipant && p.publishedTracks.length > 0,
          );
          
          if (!isPublishing) {
            setDeviceError(null);
            const promises = [];

            try {
              promises.push(cameraState.camera.enable());
            } catch (error) {
              console.error("Camera error:", error);
              setDeviceError("Failed to enable camera");
              toast({
                title: "Camera Error",
                description: "Failed to enable camera. Please check permissions.",
                variant: "destructive",
              });
            }

            try {
              promises.push(microphoneState.microphone.enable());
            } catch (error) {
              console.error("Microphone error:", error);
              setDeviceError("Failed to enable microphone");
              toast({
                title: "Microphone Error",
                description: "Failed to enable microphone. Please check permissions.",
                variant: "destructive",
              });
            }

            await Promise.allSettled(promises);
          }
        } catch (error) {
          console.error("Error enabling devices:", error);
          setDeviceError("Failed to enable devices");
          toast({
            title: "Error",
            description: "Failed to enable devices. Please check permissions and try again.",
            variant: "destructive",
          });
        }
      }
    };

    let retryCount = 0;
    const maxRetries = 3;
    
    const tryEnableDevices = async () => {
      try {
        await enableDevices();
      } catch (error) {
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`Retrying device initialization (${retryCount}/${maxRetries})...`);
          setTimeout(tryEnableDevices, 1000 * retryCount); // Exponential backoff
        } else {
          console.error("Max retries reached for device initialization");
          setDeviceError("Failed to initialize devices after multiple attempts");
          toast({
            title: "Error",
            description: "Failed to initialize devices. Please refresh and try again.",
            variant: "destructive",
          });
        }
      }
    };

    tryEnableDevices();
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

  if (deviceError) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
        <div className="text-center">
          <h2 className="text-2xl font-semibold text-red-600 mb-2">Device Error</h2>
          <p className="text-muted-foreground mb-4">{deviceError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-[calc(100vh-80px)]">
      <FlexibleCallLayout />
    </div>
  );
}
