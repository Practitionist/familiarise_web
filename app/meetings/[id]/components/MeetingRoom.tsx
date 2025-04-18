"use client";

import {
  CallParticipantsList,
  CallingState,
  PaginatedGridLayout,
  SpeakerLayout,
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import CallEnded from "./CallEnded";
import CustomCallControls from "./CustomCallControls";
import Loader from "./Loader";

// Move the component outside of the parent component
type CallLayoutProps = {
  layout: string;
};

const CallLayout = ({ layout }: CallLayoutProps) => {
  switch (layout) {
    case "grid":
      return <PaginatedGridLayout />;
    case "speaker-right":
      return <SpeakerLayout participantsBarPosition="left" />;
    default:
      return <SpeakerLayout participantsBarPosition="right" />;
  }
};

const MeetingRoom = () => {
  const searchParams = useSearchParams();
  const isPersonalRoom = !!searchParams.get("personal");
  const router = useRouter();
  const [showParticipants, setShowParticipants] = useState(false);
  const call = useCall();
  const { useCallCallingState, useCallEndedAt } = useCallStateHooks();

  // Check if we've joined the call
  const callingState = useCallCallingState();
  const callEndedAt = useCallEndedAt();

  // Track if we're trying to rejoin
  const [isRejoining, setIsRejoining] = useState(false);

  // Check if the user is the call owner
  const { useLocalParticipant } = useCallStateHooks();
  const localParticipant = useLocalParticipant();
  const isCallOwner =
    localParticipant &&
    call?.state.createdBy &&
    localParticipant.userId === call.state.createdBy.id;

  // Listen for call ended events and check if call is active
  useEffect(() => {
    if (call) {
      const handleCallStateUpdated = () => {
        console.log("Call state updated:", call.state);
      };

      call.on("call.updated", handleCallStateUpdated);

      return () => {
        call.off("call.updated", handleCallStateUpdated);
      };
    }
  }, [call]);

  // Function to rejoin the call
  const handleRejoinCall = async () => {
    if (!call) return;

    try {
      setIsRejoining(true);
      await call.join();
    } catch (error) {
      console.error("Error rejoining call:", error);
    } finally {
      setIsRejoining(false);
    }
  };

  // Show loading state while joining
  if ((callingState !== CallingState.JOINED && !callEndedAt) || isRejoining) {
    return <Loader />;
  }

  // Show call ended screen if the call has ended and user is not the owner
  // Owners can always access the call even if it was previously ended
  if (callEndedAt && !isCallOwner) {
    return (
      <CallEnded
        message="The call has been ended by the host"
        onRejoin={handleRejoinCall}
      />
    );
  }

  const toggleParticipantsBar = () => setShowParticipants((prev) => !prev);

  return (
    <section className="relative h-screen w-full overflow-hidden pt-4 text-white">
      <div className="relative flex size-full items-center justify-center">
        <div className="flex size-full max-w-[1000px] items-center">
          <CallLayout layout={"speaker-left"} />
        </div>
        <div
          className={cn("h-[calc(100vh-86px)] hidden ml-2", {
            block: showParticipants,
          })}
        >
          {showParticipants && (
            <CallParticipantsList onClose={toggleParticipantsBar} />
          )}
        </div>
      </div>

      {/* Controls Container */}
      <div className="fixed bottom-0 flex w-full items-center justify-center gap-5 flex-wrap p-2">
        <CustomCallControls
          onLeave={() => router.push("/")}
          isPersonalRoom={isPersonalRoom}
          toggleParticipantsBar={toggleParticipantsBar}
        />
      </div>
    </section>
  );
};

export default MeetingRoom;
