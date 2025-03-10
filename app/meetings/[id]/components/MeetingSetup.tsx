"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useCall,
  useCallStateHooks,
  DeviceSettings,
  VideoPreview,
} from "@stream-io/video-react-sdk";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";

interface MeetingSetupProps {
  setIsSetupComplete: (value: boolean) => void;
}

const MeetingSetup = ({ setIsSetupComplete }: MeetingSetupProps) => {
  const call = useCall();
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();

  // Initialize state based on actual device state
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0);

  // Initialize devices on component mount
  useEffect(() => {
    const initDevices = async () => {
      try {
        // Start with camera off
        await camState.camera.disable();
        setIsCameraOn(false);

        // Start with mic on
        await micState.microphone.enable();
        setIsMicOn(true);
      } catch (error) {
        console.error("Error initializing devices:", error);
      }
    };

    if (call) {
      initDevices();
    }
  }, [call, camState.camera, micState.microphone]);

  // Monitor microphone level for visual feedback using real mic input
  useEffect(() => {
    let animationFrame: number;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let microphone: MediaStreamAudioSourceNode | null = null;
    let dataArray: Uint8Array | null = null;

    // Reset mic level when toggled
    setMicLevel(0);

    const setupAudioAnalyzer = async () => {
      try {
        // Get user media for audio
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        // Create audio context and analyzer
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        // Connect microphone to analyzer
        microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);

        // Create data array for frequency data
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);

        // Start analyzing audio levels
        const updateLevel = () => {
          if (analyser && dataArray) {
            analyser.getByteFrequencyData(dataArray);

            // Calculate average volume level
            const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
            const normalizedLevel = Math.min(average / 128, 1); // Normalize to 0-1

            setMicLevel(normalizedLevel);
          }

          animationFrame = requestAnimationFrame(updateLevel);
        };

        updateLevel();
      } catch (error) {
        console.error("Error accessing microphone:", error);
      }
    };

    if (isMicOn) {
      // Small delay to ensure the mic is initialized
      const timer = setTimeout(() => {
        setupAudioAnalyzer();
      }, 100);

      return () => {
        clearTimeout(timer);
        if (animationFrame) {
          cancelAnimationFrame(animationFrame);
        }
        if (audioContext) {
          audioContext.close();
        }
      };
    }

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      if (audioContext) {
        audioContext.close();
      }
    };
  }, [isMicOn]);

  const handleJoinMeeting = async () => {
    try {
      // Join the call with current device states
      if (call) {
        await call.join();
        setIsSetupComplete(true);
      }
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-white p-4">
      <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center text-gray-900">
          {call?.state.custom?.title || "Join Meeting"}
        </h1>

        {/* Video preview */}
        <div className="mb-6 rounded-lg overflow-hidden bg-gray-900 relative" style={{ height: "300px" }}>
          <div className="w-full h-full flex items-center justify-center">
            <VideoPreview 
              mirror={true}
              className="w-full h-full object-contain"
            />
          </div>
          {!isCameraOn && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-70 text-white">
              <p className="text-lg font-medium">Camera is disabled</p>
            </div>
          )}
        </div>

        {/* Mic level indicator */}
        {isMicOn && (
          <div className="mb-4">
            <p className="text-sm text-gray-700 mb-1">Microphone Level</p>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all duration-100"
                style={{ width: `${micLevel * 100}%` }}
              ></div>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {micLevel < 0.05
                ? "No sound detected. Try speaking..."
                : "Sound detected!"}
            </p>
          </div>
        )}

        {/* Controls with Device Settings */}
        <div className="flex flex-col space-y-4 mb-6">
          {/* Camera and Mic controls */}
          <div className="flex justify-center space-x-4">
            <Button
              onClick={toggleCamera}
              variant={isCameraOn ? "default" : "outline"}
              className="w-1/2 flex items-center justify-center gap-2"
            >
              {isCameraOn ? (
                <>
                  <Video className="h-4 w-4" /> Camera On
                </>
              ) : (
                <>
                  <VideoOff className="h-4 w-4" /> Camera Off
                </>
              )}
            </Button>
            <Button
              onClick={toggleMic}
              variant={isMicOn ? "default" : "outline"}
              className="w-1/2 flex items-center justify-center gap-2"
            >
              {isMicOn ? (
                <>
                  <Mic className="h-4 w-4" /> Mic On
                </>
              ) : (
                <>
                  <MicOff className="h-4 w-4" /> Mic Off
                </>
              )}
            </Button>
          </div>

          {/* Device Settings */}
          <div className="flex justify-center">
            <DeviceSettings />
          </div>
        </div>

        {/* Join button */}
        <Button
          onClick={handleJoinMeeting}
          className="w-full bg-green-600 hover:bg-green-700"
        >
          Join Meeting
        </Button>
      </div>
    </div>
  );
};

export default MeetingSetup;
