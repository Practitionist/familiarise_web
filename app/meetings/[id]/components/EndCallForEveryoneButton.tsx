"use client";

import { useState, useEffect } from "react";
import { useCall, useCallStateHooks } from "@stream-io/video-react-sdk";
import { Button } from "@/components/ui/button";

const EndCallForEveryoneButton = () => {
  const call = useCall();
  const [isPressed, setIsPressed] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let interval: number;
    if (isPressed) {
      interval = window.setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            clearInterval(interval);
            endCall();
            return 100;
          }
          return prev + 100 / (5000 / 50); // 5 second duration with 50ms intervals
        });
      }, 50);
    }
    return () => {
      if (interval) clearInterval(interval);
      if (!isPressed) setProgress(0);
    };
  }, [isPressed]);

  if (!call)
    throw new Error(
      "useStreamCall must be used within a StreamCall component.",
    );

  // https://getstream.io/video/docs/react/guides/call-and-participant-state/#participant-state-3
  const { useLocalParticipant } = useCallStateHooks();
  const localParticipant = useLocalParticipant();

  const isMeetingOwner =
    localParticipant &&
    call.state.createdBy &&
    localParticipant.userId === call.state.createdBy.id;

  if (!isMeetingOwner) return null;

  const endCall = async () => {
    await call.endCall();
  };

  return (
    <Button
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
      className="relative overflow-hidden bg-red-500 transition-colors"
      style={{
        background: `linear-gradient(to right, rgba(239,68,68,1) ${progress}%, rgba(185,28,28,1) ${progress}%)`,
      }}
    >
      <span className="relative z-10">End call for everyone</span>
    </Button>
  );
};

export default EndCallForEveryoneButton;
