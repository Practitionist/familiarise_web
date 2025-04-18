"use client";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import {
  CallingState,
  DeviceSettings,
  useCall,
  useCallStateHooks,
  VideoPreview,
} from "@stream-io/video-react-sdk";
import { Mic, MicOff, Video, VideoOff, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface MeetingSetupProps {
  setIsSetupComplete: (value: boolean) => void;
}

// Audio analyzer helper functions moved outside component
const createAudioAnalyzer = async () => {
  try {
    // Get user media for audio
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    // Create audio context and analyzer
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    // Connect microphone to analyzer
    const microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    // Create data array for frequency data
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    return { audioContext, analyser, dataArray, bufferLength };
  } catch (error) {
    console.error("Error accessing microphone:", error);
    return null;
  }
};

const MeetingSetup = ({ setIsSetupComplete }: MeetingSetupProps) => {
  const call = useCall();
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();

  // Initialize state based on actual device state
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0);

  // Extracted device initialization function
  const initDevices = useCallback(async () => {
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
  }, [camState.camera, micState.microphone]);

  // Initialize devices on component mount
  useEffect(() => {
    if (call) {
      initDevices();
    }
  }, [call, initDevices]);

  // Extracted audio level calculation function
  const calculateAudioLevel = (
    analyser: AnalyserNode,
    dataArray: Uint8Array,
    bufferLength: number,
  ) => {
    analyser.getByteFrequencyData(dataArray);
    // Calculate average volume level
    const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
    return Math.min(average / 128, 1); // Normalize to 0-1
  };

  // Monitor microphone level for visual feedback using real mic input
  useEffect(() => {
    let animationFrame: number;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;

    // Reset mic level when toggled
    setMicLevel(0);

    // Extracted update level function
    const updateLevel = (
      analyser: AnalyserNode,
      dataArray: Uint8Array,
      bufferLength: number,
    ) => {
      const normalizedLevel = calculateAudioLevel(
        analyser,
        dataArray,
        bufferLength,
      );
      setMicLevel(normalizedLevel);
      animationFrame = requestAnimationFrame(() =>
        updateLevel(analyser, dataArray, bufferLength),
      );
    };

    const setupAnalyzer = async () => {
      const analyzerData = await createAudioAnalyzer();
      if (!analyzerData) return;

      // Destructure the analyzer components
      const {
        audioContext: context,
        analyser: analyzer,
        dataArray,
        bufferLength,
      } = analyzerData;

      // Store references for cleanup
      audioContext = context;

      // Start analyzing audio levels
      updateLevel(analyzer, dataArray, bufferLength);
    };

    if (isMicOn) {
      // Small delay to ensure the mic is initialized
      const timer = setTimeout(setupAnalyzer, 100);

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
      // Check if call exists
      if (call) {
        // Use switch case for better readability
        switch (call.state.callingState) {
          case CallingState.JOINED:
            console.log("Call is already joined");
            toast({
              title: "Already joined meeting",
              description: "You are already connected to this meeting.",
            });
            setIsSetupComplete(true);
            return;

          case CallingState.JOINING:
            console.log("Call is currently joining");
            toast({
              title: "Joining in progress",
              description: "Please wait while we connect you to the meeting.",
            });
            return;

          case CallingState.RECONNECTING:
            console.log("Call is reconnecting");
            toast({
              title: "Reconnecting to meeting",
              description: "Please wait while we reconnect you to the meeting.",
            });
            return;

          case CallingState.IDLE:
            console.log("Call is in idle state, attempting to join");
            await call.join();
            setIsSetupComplete(true);
            return;

          default:
            // For any other state, attempt to join
            console.log(
              `Call is in ${call.state.callingState} state, attempting to join`,
            );
            await call.join();
            setIsSetupComplete(true);
            return;
        }
      }
    } catch (error) {
      console.error("Error joining meeting:", error);

      // Show error toast
      toast({
        title: "Failed to join meeting",
        description:
          "There was an error joining the meeting. Please try again.",
        variant: "destructive",
      });
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-gray-100 to-gray-200 p-4 sm:p-6 md:p-8">
      <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10 w-full max-w-3xl">
        <h1 className="text-3xl font-bold mb-8 text-center text-gray-800">
          {call?.state.custom?.title || "Meeting Setup"}
        </h1>

        {/* Video preview - Conditional Rendering */}
        <div
          className="mb-8 rounded-xl overflow-hidden bg-gray-900 relative aspect-video flex items-center justify-center"
        >
          {isCameraOn ? (
            // Render VideoPreview only when camera is on
            <VideoPreview
              mirror={true}
              className="w-full h-full object-cover" // Changed to object-cover for better fit
            />
          ) : (
            // Render custom overlay only when camera is off
            <div className="flex flex-col items-center justify-center text-white p-4">
              <VideoOff className="h-12 w-12 mb-2 text-gray-400" />
              <p className="text-lg font-medium">Camera Disabled</p>
            </div>
          )}
        </div>

        {isMicOn && (
          <div className="mb-6">
            <p className="text-base font-medium text-gray-700 mb-2">Microphone Level</p>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-green-400 to-green-600 transition-all duration-100 rounded-full"
                style={{ width: `${micLevel * 100}%` }}
              ></div>
            </div>
            <p className="text-sm text-gray-600 mt-2 text-center">
              {micLevel < 0.05
                ? "No sound detected. Speak clearly..."
                : "Mic is active!"}
            </p>
          </div>
        )}

        <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-8">
          <div className="flex justify-center space-x-4 flex-1">
            <Button
              onClick={toggleCamera}
              variant={isCameraOn ? "default" : "outline"}
              size="lg"
              className="flex-1 flex items-center justify-center gap-2"
            >
              {isCameraOn ? (
                <>
                  <Video className="h-5 w-5" /> Camera On
                </>
              ) : (
                <>
                  <VideoOff className="h-5 w-5" /> Camera Off
                </>
              )}
            </Button>
            <Button
              onClick={toggleMic}
              variant={isMicOn ? "default" : "outline"}
              size="lg"
              className="flex-1 flex items-center justify-center gap-2"
            >
              {isMicOn ? (
                <>
                  <Mic className="h-5 w-5" /> Mic On
                </>
              ) : (
                <>
                  <MicOff className="h-5 w-5" /> Mic Off
                </>
              )}
            </Button>
          </div>

          <div className="flex justify-center">
            <Button variant="outline" size="icon" asChild title="Device Settings" className="p-2">
              <DeviceSettings />
            </Button>
          </div>
        </div>

        <Button
          onClick={handleJoinMeeting}
          size="lg"
          className="w-full bg-gradient-to-r from-green-500 to-green-700 hover:from-green-600 hover:to-green-800 text-white font-semibold text-lg shadow-md hover:shadow-lg transition-all duration-200 ease-in-out"
        >
          Join Meeting
        </Button>
      </div>
    </div>
  );
};

export default MeetingSetup;
