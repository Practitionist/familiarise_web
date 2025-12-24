"use client";

import { useEffect, useState } from "react";
import {
  CallControls,
  CallParticipantsList,
  CallStatsButton,
  CallingState,
  PaginatedGridLayout,
  SpeakerLayout,
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Users, LayoutList, Grid3X3, Monitor, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Loader from "./Loader";
import EndCallButton from "./EndCallButton";
import CallEnded from "./CallEnded";
import { cn } from "@/utils/tailwind";
import { StreamVideoErrorBoundary } from "@/components/stream/StreamErrorBoundary";

type CallLayoutType = "grid" | "speaker-left" | "speaker-right";

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

const layoutOptions = [
  { value: "grid", label: "Grid View", icon: Grid3X3 },
  { value: "speaker-left", label: "Speaker (Left)", icon: Monitor },
  { value: "speaker-right", label: "Speaker (Right)", icon: Monitor },
];

const MeetingRoom = () => {
  const searchParams = useSearchParams();
  const isPersonalRoom = !!searchParams.get("personal");
  const router = useRouter();
  const { data: session } = useSession();
  const [layout, setLayout] = useState<CallLayoutType>("speaker-left");
  const [showParticipants, setShowParticipants] = useState(false);
  const call = useCall();
  const { useCallCallingState, useCallEndedAt, useParticipantCount } = useCallStateHooks();

  const callingState = useCallCallingState();
  const callEndedAt = useCallEndedAt();
  const participantCount = useParticipantCount();

  const [isRejoining, setIsRejoining] = useState(false);

  useEffect(() => {
    if (callEndedAt) {
      console.log("Call ended at:", callEndedAt);
    }
  }, [callEndedAt, callingState]);

  const { useLocalParticipant } = useCallStateHooks();
  const localParticipant = useLocalParticipant();
  const isCallOwner =
    localParticipant &&
    call?.state.createdBy &&
    localParticipant.userId === call.state.createdBy.id;

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

  // Get proper dashboard URL based on user role and profile
  const getDashboardUrl = () => {
    if (!session?.user) return "/";

    const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
      session.user;

    if (role === "CONSULTANT" && consultantProfileId) {
      return `/dashboard/consultant/${consultantProfileId}/home`;
    }
    if (role === "CONSULTEE" && consulteeProfileId) {
      return `/dashboard/consultee/${consulteeProfileId}/home`;
    }
    if (role === "STAFF" && staffProfileId) {
      return `/dashboard/staff/${staffProfileId}/home`;
    }

    return "/";
  };

  // Cleanup media streams and navigate - ensures audio/video stops before navigation
  const cleanupAndNavigate = async (targetUrl: string) => {
    try {
      console.log("Starting media cleanup before navigation...");
      
      // Disable media streams first to stop audio/video
      await call?.camera.disable();
      await call?.microphone.disable();
      
      // Disable screen share if active
      if (call?.screenShare?.state?.status === "enabled") {
        await call?.screenShare.disable();
      }
      
      console.log("Media streams disabled");

      // Leave the call if still connected
      if (call?.state.callingState !== CallingState.LEFT) {
        await call?.leave();
        console.log("Left call successfully");
      }
    } catch (error) {
      console.warn("Error during cleanup:", error);
    }

    // Navigate after cleanup
    router.push(targetUrl);
  };

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

  // Handle return to home with proper cleanup
  const handleReturnHome = async () => {
    await cleanupAndNavigate(getDashboardUrl());
  };

  if ((callingState !== CallingState.JOINED && !callEndedAt) || isRejoining) {
    return <Loader />;
  }

  if (callEndedAt && !isCallOwner) {
    return (
      <CallEnded
        message="The call has been ended by the host"
        onRejoin={handleRejoinCall}
        onReturnHome={handleReturnHome}
      />
    );
  }

  return (
    <StreamVideoErrorBoundary>
      <section className="relative h-screen w-full overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
        {/* Background pattern */}
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMiI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />
        
        {/* Main content area */}
        <div className="relative flex h-full w-full">
          {/* Video Grid Area - Centered with proper padding for controls */}
          <div className="flex-1 flex items-center justify-center px-6 pt-16 pb-24">
            <div className="w-full h-full max-w-6xl flex items-center justify-center">
              <CallLayout layout={layout} />
            </div>
          </div>

          {/* Participants Sidebar */}
          <div
            className={cn(
              "fixed right-0 top-0 h-full w-80 bg-zinc-900/95 backdrop-blur-xl border-l border-zinc-800 transform transition-transform duration-300 ease-in-out z-40",
              showParticipants ? "translate-x-0" : "translate-x-full"
            )}
          >
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-zinc-400" />
                <span className="font-semibold text-white">Participants</span>
                <span className="px-2 py-0.5 bg-zinc-800 rounded-full text-xs text-zinc-400">
                  {participantCount}
                </span>
              </div>
              <button
                onClick={() => setShowParticipants(false)}
                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-zinc-400" />
              </button>
            </div>
            <div className="h-[calc(100%-60px)] overflow-y-auto">
              <CallParticipantsList onClose={() => setShowParticipants(false)} />
            </div>
          </div>

          {/* Overlay when sidebar is open on mobile */}
          {showParticipants && (
            <div
              className="fixed inset-0 bg-black/50 z-30 lg:hidden"
              onClick={() => setShowParticipants(false)}
            />
          )}
        </div>

        {/* Bottom Control Bar */}
        <div className="fixed bottom-0 left-0 right-0 z-50">
          <div className="flex items-center justify-center px-4 py-4">
            <div className="flex items-center gap-2 px-4 py-3 bg-zinc-900/90 backdrop-blur-xl rounded-2xl border border-zinc-800 shadow-2xl">
              {/* Stream Call Controls */}
              <CallControls
                onLeave={async () => {
                  console.log("Participant leaving call");
                  await cleanupAndNavigate(getDashboardUrl());
                }}
              />

              {/* Divider */}
              <div className="w-px h-8 bg-zinc-700 mx-1" />

              {/* Layout Selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="p-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 transition-colors">
                    <LayoutList className="w-5 h-5 text-white" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="center"
                  className="bg-zinc-900 border-zinc-800 p-2 rounded-xl min-w-[180px]"
                  sideOffset={12}
                >
                  {layoutOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => setLayout(option.value as CallLayoutType)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        layout === option.value
                          ? "bg-zinc-800 text-white"
                          : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
                      )}
                    >
                      <option.icon className="w-4 h-4" />
                      <span className="text-sm font-medium">{option.label}</span>
                      {layout === option.value && (
                        <div className="ml-auto w-2 h-2 rounded-full bg-emerald-500" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Stats Button */}
              <CallStatsButton />

              {/* Participants Toggle */}
              <button
                onClick={() => setShowParticipants((prev) => !prev)}
                className={cn(
                  "p-3 rounded-xl transition-colors relative",
                  showParticipants
                    ? "bg-emerald-500 text-white"
                    : "bg-zinc-800 hover:bg-zinc-700 text-white"
                )}
              >
                <Users className="w-5 h-5" />
                {participantCount > 1 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-emerald-500 rounded-full text-xs font-medium flex items-center justify-center">
                    {participantCount}
                  </span>
                )}
              </button>

              {/* Divider */}
              {!isPersonalRoom && <div className="w-px h-8 bg-zinc-700 mx-1" />}

              {/* End Call Button */}
              {!isPersonalRoom && <EndCallButton />}
            </div>
          </div>
        </div>

        {/* Meeting Info Badge */}
        <div className="fixed top-4 left-4 z-40">
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/80 backdrop-blur-sm rounded-lg border border-zinc-800">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-white">
              {call?.state.custom?.title || "Meeting"}
            </span>
            <span className="text-xs text-zinc-500">
              • {participantCount} participant{participantCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </section>
    </StreamVideoErrorBoundary>
  );
};

export default MeetingRoom;
