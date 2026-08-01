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
  CalendarClock,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/utils/tailwind";
import {
  formatScheduledAt,
  sessionHeading,
  sessionSubheading,
  useSessionClock,
  useSessionInfo,
} from "../session-info";
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

/**
 * Meters the microphone the CALL already owns.
 *
 * This used to open its own `getUserMedia({ audio: true })` and only ever
 * close the AudioContext on cleanup — which does not stop a MediaStreamTrack.
 * That second, un-owned capture stayed live for the life of the tab (a fresh
 * one per mic toggle), so the browser kept showing the recording indicator
 * long after the user had left the meeting. Reading Stream's stream means
 * there is exactly one capture, and the teardown that releases the call
 * releases it too.
 */
const createAudioAnalyzer = (stream: MediaStream) => {
  try {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    audioContext.createMediaStreamSource(stream).connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;

    return { audioContext, analyser, dataArray, bufferLength };
  } catch (error) {
    console.error("Error metering microphone:", error);
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

const calculateAudioLevel = (
  analyser: AnalyserNode,
  dataArray: Uint8Array<ArrayBuffer>,
  bufferLength: number,
) => {
  analyser.getByteFrequencyData(dataArray);
  const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
  return Math.min(average / 128, 1);
};

const MeetingSetup = ({ setIsSetupComplete }: MeetingSetupProps) => {
  const call = useCall();
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();

  // Device state is read from the SDK rather than mirrored into local booleans,
  // which could disagree with the hardware after a failed toggle.
  const isMicOn = micState.isEnabled;
  const isCameraOn = camState.isEnabled;
  const micStream = micState.mediaStream;

  const [micLevel, setMicLevel] = useState(0);
  const [isJoining, setIsJoining] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const info = useSessionInfo();
  const clock = useSessionClock(info.startsAt, info.endsAt);
  const scheduledAt = formatScheduledAt(info.startsAt);
  const heading = sessionHeading(info);
  const subheading = sessionSubheading(info);

  const initDevices = useCallback(async () => {
    try {
      await camState.camera.disable();
      await micState.microphone.enable();
    } catch (error) {
      console.error("Error initializing devices:", error);
    }
  }, [camState.camera, micState.microphone]);

  useEffect(() => {
    if (call) {
      initDevices();
    }
  }, [call, initDevices]);

  useEffect(() => {
    setMicLevel(0);
    if (!isMicOn || !micStream) return;

    let animationFrame: number;

    const analyzerData = createAudioAnalyzer(micStream);
    if (!analyzerData) return;
    const { audioContext, analyser, dataArray, bufferLength } = analyzerData;
    // A context built before the page has seen a gesture starts suspended, and
    // a suspended analyser reports silence — which reads as a broken mic.
    void audioContext.resume().catch(() => {});

    const updateLevel = () => {
      setMicLevel(calculateAudioLevel(analyser, dataArray, bufferLength));
      animationFrame = requestAnimationFrame(updateLevel);
    };
    updateLevel();

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      // Only the meter is torn down here. The stream belongs to the call, so
      // stopping its tracks would mute the user on join.
      void audioContext.close();
    };
  }, [isMicOn, micStream]);

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
      await camState.camera.toggle();
    } catch (error) {
      console.error("Error toggling camera:", error);
    }
  };

  const toggleMic = async () => {
    try {
      await micState.microphone.toggle();
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
          {/* Header — the person first, the offering under it, and the type
              as a quiet chip. It was an upper-cased enum in the largest type
              on the screen, above the name of the person you are meeting. */}
          <div className="px-6 pt-7 pb-5 sm:px-8">
            <div className="flex flex-wrap items-center gap-2">
              {info.typeLabel && (
                <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                  {info.typeLabel}
                </span>
              )}
              {clock.status && (
                <span
                  className={cn(
                    "px-2 py-0.5 rounded-full text-xs font-medium",
                    clock.phase === "in-progress" ||
                      clock.phase === "overrunning"
                      ? "bg-green-500/15 text-green-500"
                      : clock.phase === "starting-soon"
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {clock.phase === "in-progress" ||
                  clock.phase === "overrunning"
                    ? "In progress"
                    : clock.status}
                </span>
              )}
            </div>

            <h1 className="mt-2 text-fluid-2xl font-semibold tracking-tight text-foreground truncate">
              {heading}
            </h1>
            {subheading && (
              <p className="text-muted-foreground text-sm truncate">
                {subheading}
              </p>
            )}

            {(scheduledAt || info.durationMinutes) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {scheduledAt && (
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarClock className="w-4 h-4 shrink-0" />
                    {scheduledAt}
                  </span>
                )}
                {info.durationMinutes && (
                  <span className="inline-flex items-center gap-1.5">
                    <Timer className="w-4 h-4 shrink-0" />
                    {info.durationMinutes} min
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Video Preview — nothing is overlaid on it now; the device state
              reads underneath, where it does not sit on top of your face. */}
          <div className="px-6 pb-3">
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
            </div>
          </div>

          {/* Device state + mic level */}
          <div className="px-6 pb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 border",
                  isMicOn
                    ? "border-border text-foreground"
                    : "border-red-500/40 text-red-500",
                )}
              >
                {isMicOn ? (
                  <Mic className="w-3 h-3" />
                ) : (
                  <MicOff className="w-3 h-3" />
                )}
                {isMicOn ? "Mic on" : "Mic off"}
              </span>
              <span
                className={cn(
                  "px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 border",
                  isCameraOn
                    ? "border-border text-foreground"
                    : "border-red-500/40 text-red-500",
                )}
              >
                {isCameraOn ? (
                  <Video className="w-3 h-3" />
                ) : (
                  <VideoOff className="w-3 h-3" />
                )}
                {isCameraOn ? "Camera on" : "Camera off"}
              </span>
            </div>

            {isMicOn && (
              // The meter used to read "Waiting…" with nothing to say what it
              // was waiting for. It is now labelled, and says what to do.
              <div>
                <div className="flex items-center gap-3">
                  <Mic className="w-4 h-4 text-muted-foreground/70 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-foreground transition-all duration-75"
                        style={{ width: `${Math.max(micLevel * 100, 2)}%` }}
                      />
                    </div>
                  </div>
                </div>
                <p className="mt-1.5 pl-7 text-xs text-muted-foreground">
                  {micLevel < 0.05
                    ? "Say something to check your microphone"
                    : "We can hear you"}
                </p>
              </div>
            )}
          </div>

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
              ) : clock.phase === "in-progress" ||
                clock.phase === "overrunning" ? (
                "Join now"
              ) : clock.phase === "early" ? (
                "Join early"
              ) : (
                "Join meeting"
              )}
            </Button>
          </div>
        </div>

        {/* Replaces "Tip: test your mic and camera before joining", which
            restated the screen. This only appears when there is something the
            person would otherwise be surprised by. */}
        {(!micState.hasBrowserPermission || !isCameraOn) && (
          <p className="text-center text-muted-foreground text-xs mt-4">
            {!micState.hasBrowserPermission
              ? "Your browser is blocking the microphone. Allow access to be heard."
              : "Your camera is off — you will join with audio only."}
          </p>
        )}
      </div>
    </div>
  );
};

export default MeetingSetup;
