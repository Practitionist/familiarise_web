"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useCall } from "@stream-io/video-react-sdk";

const MeetingRoom = () => {
  const router = useRouter();
  const call = useCall();

  const handleLeaveCall = async () => {
    try {
      await call?.leave();
      router.back();
    } catch (error) {
      console.error("Error leaving call:", error);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Top bar with meeting info and controls */}
      <div className="bg-white border-b p-4 flex justify-between items-center">
        <div>
          <h1 className="text-xl font-semibold">
            {call?.state.custom?.title || `Meeting: ${call?.id}`}
          </h1>
          <p className="text-sm text-gray-500">
            {call?.state.custom?.description || "Video Meeting"}
          </p>
        </div>
        <Button onClick={handleLeaveCall} variant="destructive">
          Leave Meeting
        </Button>
      </div>

      {/* Main video area */}
      <div className="flex-1 bg-gray-100 p-4">
        {/* This is where the Stream SDK will render the video participants */}
      </div>

      {/* Bottom controls */}
      <div className="bg-white border-t p-4 flex justify-center space-x-4">
        {/* Stream SDK will handle these controls */}
      </div>
    </div>
  );
};

export default MeetingRoom;
