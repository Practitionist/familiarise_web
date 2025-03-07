"use client";

import { useEffect, useRef, useState } from "react";
import {
  DeviceSettings,
  VideoPreview,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { useToast } from "@/components/ui/use-toast";
import Button from "./button";
import AudioVolumeIndicator from "./audio-volume-indicator";
import PermissionPrompt from "./permission-prompt";

interface SetupUIProps {
  onSetupComplete: () => void;
}

interface DeviceSetupError {
  camera?: string;
  microphone?: string;
}

export default function SetupUI({ onSetupComplete }: Readonly<SetupUIProps>) {
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();
  const [micCamDisabled, setMicCamDisabled] = useState(false);
  const [setupError, setSetupError] = useState<DeviceSetupError>({});
  const [isRetrying, setIsRetrying] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { toast } = useToast();

  const setupDevices = async (retryAttempt = 0) => {
    setIsRetrying(true);
    setSetupError({});
    
    try {
      if (micCamDisabled) {
        const promises = [];
        if (micState.microphone.enabled) {
          promises.push(micState.microphone.disable());
        }
        if (camState.camera.enabled) {
          promises.push(camState.camera.disable());
        }
        await Promise.all(promises);
      } else {
        // Try to enable microphone
        try {
          if (!micState.microphone.enabled) {
            await micState.microphone.enable();
          }
        } catch (error) {
          console.error("Microphone setup error:", error);
          setSetupError(prev => ({ ...prev, microphone: "Failed to enable microphone" }));
          toast({
            title: "Microphone Error",
            description: "Failed to enable microphone. Please check permissions.",
            variant: "destructive",
          });
        }

        // Try to enable camera
        try {
          if (!camState.camera.enabled) {
            await camState.camera.enable();
          }
        } catch (error) {
          console.error("Camera setup error:", error);
          setSetupError(prev => ({ ...prev, camera: "Failed to enable camera" }));
          toast({
            title: "Camera Error",
            description: "Failed to enable camera. Please check permissions.",
            variant: "destructive",
          });
        }
      }
    } catch (error) {
      console.error("Error setting up devices:", error);
      if (retryAttempt < 3) {
        console.log(`Retrying device setup (${retryAttempt + 1}/3)...`);
        setTimeout(() => setupDevices(retryAttempt + 1), 1000 * (retryAttempt + 1));
      } else {
        toast({
          title: "Error",
          description: "Failed to set up devices after multiple attempts. Please refresh and try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsRetrying(false);
    }
  };

  useEffect(() => {
    setupDevices();

    return () => {
      const cleanup = async () => {
        try {
          const promises = [];
          if (micState.microphone.enabled) {
            promises.push(micState.microphone.disable());
          }
          if (camState.camera.enabled) {
            promises.push(camState.camera.disable());
          }
          await Promise.all(promises);
        } catch (error) {
          console.error("Error cleaning up devices:", error);
          toast({
            title: "Error",
            description: "Failed to clean up devices properly",
            variant: "destructive",
          });
        }
      };
      cleanup().catch(console.error);
    };
  }, [micCamDisabled]);

  if (!micState.hasBrowserPermission || !camState.hasBrowserPermission) {
    return <PermissionPrompt onRetry={() => setupDevices()} />;
  }

  const hasError = Object.keys(setupError).length > 0;

  return (
    <div className="flex flex-col items-center gap-3">
      <h1 className="text-2xl font-bold">Setup</h1>
      
      {hasError && (
        <div className="w-full max-w-md bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <h3 className="text-red-800 font-semibold mb-2">Device Setup Issues:</h3>
          <ul className="list-disc list-inside text-red-700">
            {setupError.camera && <li>{setupError.camera}</li>}
            {setupError.microphone && <li>{setupError.microphone}</li>}
          </ul>
          <button
            onClick={() => setupDevices()}
            className="mt-2 text-red-600 hover:text-red-800 font-medium"
            disabled={isRetrying}
          >
            {isRetrying ? "Retrying..." : "Retry Device Setup"}
          </button>
        </div>
      )}

      <div className="w-[640px] h-[360px] bg-gray-900 rounded-lg overflow-hidden">
        <VideoPreview />
      </div>
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
      <Button 
        onClick={onSetupComplete}
        disabled={hasError && !micCamDisabled}
      >
        Join meeting
      </Button>
    </div>
  );
}
