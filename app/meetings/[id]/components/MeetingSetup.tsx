"use client";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import {
  CallingState,
  useCall,
  useCallStateHooks,
  VideoPreview,
} from "@stream-io/video-react-sdk";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Settings,
  Loader2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/utils/tailwind";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface MeetingSetupProps {
  setIsSetupComplete: (value: boolean) => void;
}

// Audio analyzer helper functions moved outside component
const createAudioAnalyzer = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    const microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;

    return { audioContext, analyser, dataArray, bufferLength };
  } catch (error) {
    console.error("Error accessing microphone:", error);
    return null;
  }
};

const DeviceSelector = () => {
  const { useMicrophoneState, useCameraState, useSpeakerState } =
    useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();
  const speakerState = useSpeakerState?.();

  const [selectedMic, setSelectedMic] = useState<string>("");
  const [selectedCam, setSelectedCam] = useState<string>("");
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>("");

  useEffect(() => {
    if (micState.selectedDevice) setSelectedMic(micState.selectedDevice);
  }, [micState.selectedDevice]);

  useEffect(() => {
    if (camState.selectedDevice) setSelectedCam(camState.selectedDevice);
  }, [camState.selectedDevice]);

  useEffect(() => {
    if (speakerState?.selectedDevice)
      setSelectedSpeaker(speakerState.selectedDevice);
  }, [speakerState?.selectedDevice]);

  return (
    <div className="space-y-4">
      {/* Camera */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Video className="w-4 h-4" />
          <Label className="text-sm font-medium">Camera</Label>
        </div>
        <Select
          value={selectedCam}
          onValueChange={async (val) => {
            setSelectedCam(val);
            await camState.camera.select(val);
          }}
        >
          <SelectTrigger className="bg-card border-border">
            <SelectValue placeholder="Select Camera" />
          </SelectTrigger>
          <SelectContent>
            {camState.devices?.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${d.deviceId}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Microphone */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Mic className="w-4 h-4" />
          <Label className="text-sm font-medium">Microphone</Label>
        </div>
        <Select
          value={selectedMic}
          onValueChange={async (val) => {
            setSelectedMic(val);
            await micState.microphone.select(val);
          }}
        >
          <SelectTrigger className="bg-card border-border">
            <SelectValue placeholder="Select Microphone" />
          </SelectTrigger>
          <SelectContent>
            {micState.devices?.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${d.deviceId}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Speakers */}
      {speakerState?.devices && speakerState.devices.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Volume2 className="w-4 h-4" />
            <Label className="text-sm font-medium">Speakers</Label>
          </div>
          <Select
            value={selectedSpeaker}
            onValueChange={async (val) => {
              setSelectedSpeaker(val);
              await speakerState.speaker.select(val);
            }}
          >
            <SelectTrigger className="bg-card border-border">
              <SelectValue placeholder="Select Speakers" />
            </SelectTrigger>
            <SelectContent>
              {speakerState.devices.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker ${d.deviceId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
};

const MeetingSetup = ({ setIsSetupComplete }: MeetingSetupProps) => {
  const call = useCall();
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();

  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [isJoining, setIsJoining] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const initDevices = useCallback(async () => {
    try {
      await camState.camera.disable();
      setIsCameraOn(false);
      await micState.microphone.enable();
      setIsMicOn(true);
    } catch (error) {
      console.error("Error initializing devices:", error);
    }
  }, [camState.camera, micState.microphone]);

  useEffect(() => {
    if (call) {
      initDevices();
    }
  }, [call, initDevices]);

  const calculateAudioLevel = (
    analyser: AnalyserNode,
    dataArray: Uint8Array<ArrayBuffer>,
    bufferLength: number,
  ) => {
    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
    return Math.min(average / 128, 1);
  };

  useEffect(() => {
    let animationFrame: number;
    let audioContext: AudioContext | null = null;

    setMicLevel(0);

    const updateLevel = (
      analyser: AnalyserNode,
      dataArray: Uint8Array<ArrayBuffer>,
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

      const {
        audioContext: context,
        analyser: analyzer,
        dataArray,
        bufferLength,
      } = analyzerData;

      audioContext = context;
      updateLevel(analyzer, dataArray, bufferLength);
    };

    if (isMicOn) {
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
      setIsJoining(true);
      if (call) {
        switch (call.state.callingState) {
          case CallingState.JOINED:
            toast({
              title: "Already joined meeting",
              description: "You are already connected to this meeting.",
            });
            setIsSetupComplete(true);
            return;

          case CallingState.JOINING:
            toast({
              title: "Joining in progress",
              description: "Please wait while we connect you to the meeting.",
            });
            return;

          case CallingState.RECONNECTING:
            toast({
              title: "Reconnecting to meeting",
              description: "Please wait while we reconnect you to the meeting.",
            });
            return;

          case CallingState.IDLE:
            await call.join();
            setIsSetupComplete(true);
            return;

          default:
            await call.join();
            setIsSetupComplete(true);
            return;
        }
      }
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Failed to join meeting",
        description:
          "There was an error joining the meeting. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsJoining(false);
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMyMjIiIGZpbGwtb3BhY2l0eT0iMC4wNSI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

      <div className="relative z-10 w-full max-w-lg">
        {/* Card */}
        <div className="bg-card/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-border/50 overflow-hidden">
          {/* Header */}
          <div className="px-6 pt-8 pb-4 sm:px-8">
            <h1 className="text-fluid-2xl font-bold tracking-tight text-foreground text-center">
              {call?.state.custom?.title || "Join Meeting"}
            </h1>
            <p className="text-muted-foreground text-sm text-center mt-1">
              Configure your audio and video before joining
            </p>
          </div>

          {/* Video Preview */}
          <div className="px-6 pb-4">
            <div
              className="relative rounded-xl overflow-hidden bg-zinc-900 shadow-inner"
              style={{ aspectRatio: "16/9" }}
            >
              <VideoPreview
                mirror={true}
                className="w-full h-full object-cover"
              />
              {!isCameraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900">
                  <div className="w-20 h-20 rounded-full bg-zinc-800 flex items-center justify-center mb-3">
                    <VideoOff className="w-8 h-8 text-zinc-500" />
                  </div>
                  <p className="text-zinc-400 text-sm font-medium">
                    Camera is off
                  </p>
                </div>
              )}

              {/* Camera/Mic status indicators */}
              <div className="absolute bottom-3 left-3 flex gap-2">
                <div
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 backdrop-blur-sm",
                    isMicOn
                      ? "bg-green-500/20 text-green-400"
                      : "bg-red-500/20 text-red-400",
                  )}
                >
                  {isMicOn ? (
                    <Mic className="w-3 h-3" />
                  ) : (
                    <MicOff className="w-3 h-3" />
                  )}
                  {isMicOn ? "Mic on" : "Mic off"}
                </div>
                <div
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 backdrop-blur-sm",
                    isCameraOn
                      ? "bg-green-500/20 text-green-400"
                      : "bg-red-500/20 text-red-400",
                  )}
                >
                  {isCameraOn ? (
                    <Video className="w-3 h-3" />
                  ) : (
                    <VideoOff className="w-3 h-3" />
                  )}
                  {isCameraOn ? "Camera on" : "Camera off"}
                </div>
              </div>
            </div>
          </div>

          {/* Mic Level Indicator */}
          {isMicOn && (
            <div className="px-6 pb-4">
              <div className="flex items-center gap-3">
                <Mic className="w-4 h-4 text-muted-foreground/70" />
                <div className="min-w-0 flex-1">
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-foreground transition-all duration-75"
                      style={{ width: `${Math.max(micLevel * 100, 2)}%` }}
                    />
                  </div>
                </div>
                <span className="text-xs text-muted-foreground w-20 text-right">
                  {micLevel < 0.05 ? "Waiting..." : "Speaking"}
                </span>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="px-6 pb-6">
            <div className="flex items-center justify-center gap-3">
              {/* Mic Toggle */}
              <button
                onClick={toggleMic}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200",
                  isMicOn
                    ? "bg-foreground text-background hover:bg-foreground/90"
                    : "bg-red-500 text-white hover:bg-red-600",
                )}
              >
                {isMicOn ? (
                  <Mic className="w-5 h-5" />
                ) : (
                  <MicOff className="w-5 h-5" />
                )}
              </button>

              {/* Camera Toggle */}
              <button
                onClick={toggleCamera}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200",
                  isCameraOn
                    ? "bg-foreground text-background hover:bg-foreground/90"
                    : "bg-red-500 text-white hover:bg-red-600",
                )}
              >
                {isCameraOn ? (
                  <Video className="w-5 h-5" />
                ) : (
                  <VideoOff className="w-5 h-5" />
                )}
              </button>

              {/* Settings Toggle */}
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200",
                  showSettings
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
              >
                <Settings className="w-5 h-5" />
              </button>
            </div>

            {/* Device Settings */}
            {showSettings && (
              <div className="mt-4 p-4 bg-muted rounded-xl border border-border">
                <p className="text-sm font-medium text-muted-foreground mb-3">
                  Audio & Video Settings
                </p>
                <DeviceSelector />
              </div>
            )}
          </div>

          {/* Join Button */}
          <div className="px-6 pb-8">
            <Button
              onClick={handleJoinMeeting}
              disabled={isJoining}
              className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl shadow-lg transition-all duration-200 disabled:opacity-70"
            >
              {isJoining ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Joining...
                </>
              ) : (
                "Join Meeting"
              )}
            </Button>
          </div>
        </div>

        {/* Footer tip */}
        <p className="text-center text-muted-foreground text-xs mt-4">
          Tip: Test your mic and camera before joining
        </p>
      </div>
    </div>
  );
};

export default MeetingSetup;
