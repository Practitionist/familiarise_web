'use client';

import { useEffect, useRef, useState } from "react";
import { DeviceSettings, VideoPreview, useCallStateHooks } from "@stream-io/video-react-sdk";
import Button from "./button";
import AudioVolumeIndicator from "./audio-volume-indicator";
import PermissionPrompt from "./permission-prompt";

interface SetupUIProps {
  onSetupComplete: () => void;
}

export default function SetupUI({ onSetupComplete }: Readonly<SetupUIProps>) {
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();
  const [micCamDisabled, setMicCamDisabled] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const setupDevices = async () => {
      try {
        if (micCamDisabled) {
          if (micState.microphone.enabled) {
            await micState.microphone.disable();
          }
          if (camState.camera.enabled) {
            await camState.camera.disable();
          }
        } else {
          if (!micState.microphone.enabled) {
            await micState.microphone.enable();
          }
          if (!camState.camera.enabled) {
            await camState.camera.enable();
          }
        }
      } catch (error) {
        console.error('Error setting up devices:', error);
      }
    };

    setupDevices();

    return () => {
      const cleanup = async () => {
        try {
          if (micState.microphone.enabled) {
            await micState.microphone.disable();
          }
          if (camState.camera.enabled) {
            await camState.camera.disable();
          }
        } catch (error) {
          console.error('Error cleaning up devices:', error);
        }
      };
      cleanup();
    };
  }, [micCamDisabled]);

  if (!micState.hasBrowserPermission || !camState.hasBrowserPermission) {
    return <PermissionPrompt />;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <h1 className="text-2xl font-bold">Setup</h1>
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
      <Button onClick={onSetupComplete}>Join meeting</Button>
    </div>
  );
}
