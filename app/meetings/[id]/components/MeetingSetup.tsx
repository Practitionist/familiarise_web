"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useCall,
  useCallStateHooks,
  DeviceSettings,
  VideoPreview,
} from "@stream-io/video-react-sdk";

interface MeetingSetupProps {
  setIsSetupComplete: (value: boolean) => void;
}

const MeetingSetup = ({ setIsSetupComplete }: MeetingSetupProps) => {
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const call = useCall();
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();

  const handleJoinMeeting = async () => {
    try {
      // Set initial device states
      if (!isCameraOn) {
        await camState.camera.disable();
      }
      if (!isMicOn) {
        await micState.microphone.disable();
      }

      // Mark setup as complete to show the meeting room
      setIsSetupComplete(true);
    } catch (error) {
      console.error("Error joining meeting:", error);
    }
  };

  const toggleCamera = async () => {
    try {
      if (isCameraOn) {
        await camState.camera.disable();
      } else {
        await camState.camera.enable();
      }
      setIsCameraOn(!isCameraOn);
    } catch (error) {
      console.error("Error toggling camera:", error);
    }
  };

  const toggleMic = async () => {
    try {
      if (isMicOn) {
        await micState.microphone.disable();
      } else {
        await micState.microphone.enable();
      }
      setIsMicOn(!isMicOn);
    } catch (error) {
      console.error("Error toggling microphone:", error);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center">
          {call?.state.custom?.title || "Join Meeting"}
        </h1>

        {/* Video preview */}
        <div className="mb-6 rounded-lg overflow-hidden bg-gray-900 aspect-video">
          <VideoPreview />
        </div>

        {/* Device settings */}
        <div className="mb-6">
          <DeviceSettings />
        </div>

        {/* Controls */}
        <div className="flex justify-center space-x-4 mb-6">
          <Button
            onClick={toggleCamera}
            variant={isCameraOn ? "default" : "outline"}
            className="w-1/2"
          >
            {isCameraOn ? "Camera On" : "Camera Off"}
          </Button>
          <Button
            onClick={toggleMic}
            variant={isMicOn ? "default" : "outline"}
            className="w-1/2"
          >
            {isMicOn ? "Mic On" : "Mic Off"}
          </Button>
        </div>

        {/* Join button */}
        <Button onClick={handleJoinMeeting} className="w-full">
          Join Meeting
        </Button>
      </div>
    </div>
  );
};

export default MeetingSetup;
