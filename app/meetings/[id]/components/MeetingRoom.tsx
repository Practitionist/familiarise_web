"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CallParticipantsList,
  CallStatsButton,
  CallingState,
  PaginatedGridLayout,
  SpeakerLayout,
  SpeakingWhileMutedNotification,
  useCall,
  useCallStateHooks,
  ToggleAudioPublishingButton,
  ToggleVideoPublishingButton,
  ReactionsButton,
  ScreenShareButton,
} from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import {
  Users,
  LayoutList,
  Grid3X3,
  Monitor,
  X,
  Phone,
  MoreVertical,
  Radio,
  MessageSquareText,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import EndCallButton from "./EndCallButton";
import CallEnded from "./CallEnded";
import RecordingControls from "./RecordingControls";
import { StageControls } from "./StageControls";
import { StagePinnedBannerOverlay } from "./StagePinnedBannerOverlay";
import { StageQaDrawer } from "./StageQaDrawer";
import { OverrunBanner } from "./OverrunBanner";
import { ConnectionQualityNotice } from "./ConnectionQualityNotice";
import { ConnectionStateScreen } from "./ConnectionStateScreen";
import { IncomingVideoQualityMenu } from "./IncomingVideoQualityMenu";
import { useMeetingRecording } from "../hooks/useMeetingRecording";
import {
  sessionHeading,
  useSessionClock,
  useSessionInfo,
} from "../session-info";
import {
  DISCONNECTION_TIMEOUT_SECONDS,
  describeCallingState,
} from "@/lib/stream/connection-state";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";
import {
  applyIncomingVideoSetting,
  type IncomingVideoSetting,
} from "@/lib/stream/incoming-video";
import { cn } from "@/utils/tailwind";
import { StreamVideoErrorBoundary } from "@/components/stream/StreamErrorBoundary";

import {
  isAwaitingHostGoLive,
  isInCallChatAllowed,
  isOneToManyAppointmentType,
} from "@/lib/meetings/room-ready";
import {
  normalizeStageBannerFromCustomData,
  STAGE_QA_EVENT_TYPES,
  stageQuestionSchema,
  type StagePinnedBanner,
  type StageQuestion,
} from "@/lib/meetings/stage-qa";

export { isInCallChatAllowed };

const useDefaultTrue = () => true;
const useDefaultUndefined = () => undefined;

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

/** Isolated clock pill that subscribes to per-second ticks without re-rendering the video stage. */
function SessionClockPill({
  startsAt,
  endsAt,
}: {
  startsAt: Date | null;
  endsAt: Date | null;
}) {
  const clock = useSessionClock(startsAt, endsAt);
  if (!clock.elapsed) return null;

  return (
    <div
      className={cn(
        "pointer-events-auto flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 backdrop-blur-sm",
        clock.phase === "overrunning"
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-zinc-800 bg-zinc-900/80",
      )}
    >
      <div
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          clock.phase === "overrunning"
            ? "bg-amber-400"
            : "animate-pulse bg-white",
        )}
      />
      <span
        className={cn(
          "text-sm font-medium",
          clock.phase === "overrunning" ? "text-amber-200" : "text-white",
        )}
      >
        {clock.status}
      </span>
      <span
        className={cn(
          "hidden text-xs tabular-nums sm:inline",
          clock.phase === "overrunning" ? "text-amber-300/80" : "text-zinc-500",
        )}
      >
        {clock.elapsedLabel}
      </span>
    </div>
  );
}

interface MeetingRoomProps {
  onRejoin: () => void;
  role?: "host" | "participant" | null;
}

const MeetingRoom = ({ onRejoin, role }: MeetingRoomProps) => {
  const router = useRouter();
  const { data: session } = useSession();
  const [layout, setLayout] = useState<CallLayoutType>("speaker-left");
  const [activeSideTab, setActiveSideTab] = useState<
    "participants" | "qa" | null
  >(null);
  const [questions, setQuestions] = useState<StageQuestion[]>([]);
  const [activeBanner, setActiveBanner] = useState<StagePinnedBanner | null>(
    null,
  );
  const [qaError, setQaError] = useState<string | null>(null);
  const [isQaSubmitting, setIsQaSubmitting] = useState(false);
  const [exit, setExit] = useState<"leaving" | "ending" | null>(null);
  const handleEnding = useCallback(() => setExit("ending"), []);
  const call = useCall();
  const callStateHooks = useCallStateHooks();
  const { useCallCallingState, useCallEndedAt, useParticipantCount } =
    callStateHooks;
  const useIsCallLive = callStateHooks.useIsCallLive ?? useDefaultTrue;
  const useCallSettings = callStateHooks.useCallSettings ?? useDefaultUndefined;
  const useCallCustomData =
    callStateHooks.useCallCustomData ?? useDefaultUndefined;

  const { meetingId, recordingEnabled } = useMeetingRecording(call?.id);

  const callingState = useCallCallingState();
  const callEndedAt = useCallEndedAt();
  const participantCount = useParticipantCount();
  const isCallLive = useIsCallLive();
  const callSettings = useCallSettings();
  const callCustomData = useCallCustomData();

  // Set Stream disconnection timeout so dropped connections emit participant_left events.
  useEffect(() => {
    call?.setDisconnectionTimeout(DISCONNECTION_TIMEOUT_SECONDS);
  }, [call]);

  const info = useSessionInfo(role);
  const isHost = info.isHost;
  const inCallChatAllowed = isInCallChatAllowed(info.appointmentType);
  const isOneToMany = isOneToManyAppointmentType(info.appointmentType);
  const isBackstageEnabled = Boolean(callSettings?.backstage?.enabled);
  const awaitingGoLive = isAwaitingHostGoLive({
    appointmentType: info.appointmentType,
    isCallLive,
    isBackstageEnabled,
  });
  const defaultIncomingVideoCap: IncomingVideoSetting = isOneToMany
    ? "720p"
    : "480p";

  // Hydrate and sync active ON SCREEN banner from server-authoritative call.state.custom.
  useEffect(() => {
    if (!inCallChatAllowed) return;
    const syncedBanner = normalizeStageBannerFromCustomData(
      callCustomData as Record<string, unknown> | undefined,
    );
    setActiveBanner(syncedBanner);
  }, [callCustomData, inCallChatAllowed]);

  // Subscribe to real-time Q&A and ON SCREEN stage banner events over Stream WebSocket.
  useEffect(() => {
    if (!call || !inCallChatAllowed || typeof call.on !== "function") return;

    const handleCustomEvent = (event: { custom?: Record<string, unknown> }) => {
      const custom = event?.custom;
      if (!custom || typeof custom.type !== "string") return;

      if (custom.type === STAGE_QA_EVENT_TYPES.QUESTION_ASKED) {
        const parsedQuestion = stageQuestionSchema.safeParse(custom.question);
        if (!parsedQuestion.success) return;
        const incoming = parsedQuestion.data;
        setQuestions((prev) =>
          prev.some((item) => item.id === incoming.id)
            ? prev
            : [...prev, incoming],
        );
      } else if (custom.type === STAGE_QA_EVENT_TYPES.BANNER_PINNED) {
        const normalized = normalizeStageBannerFromCustomData({
          activeStageBanner: custom.banner,
        });
        if (normalized) {
          setActiveBanner(normalized);
        }
      } else if (custom.type === STAGE_QA_EVENT_TYPES.BANNER_UNPINNED) {
        setActiveBanner(null);
      }
    };

    const unsubscribe = call.on("custom", handleCustomEvent as never);
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [call, inCallChatAllowed]);

  const targetQaMeetingId = meetingId ?? call?.id ?? "";

  const handleAskQuestion = useCallback(
    async (text: string) => {
      if (!targetQaMeetingId) return;
      setQaError(null);
      setIsQaSubmitting(true);
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(targetQaMeetingId)}/qa`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "ask", text }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error ?? "Failed to send question");
        }
        if (body?.question) {
          setQuestions((prev) =>
            prev.some((q) => q.id === body.question.id)
              ? prev
              : [...prev, body.question],
          );
        }
      } finally {
        setIsQaSubmitting(false);
      }
    },
    [targetQaMeetingId],
  );

  const handlePinQuestion = useCallback(
    async (question: StageQuestion) => {
      if (!targetQaMeetingId || !isHost) return;
      setQaError(null);
      setIsQaSubmitting(true);
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(targetQaMeetingId)}/qa`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "pin",
              questionId: question.id,
            }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setQaError(body?.error ?? "Failed to pin question");
          return;
        }
        if (body?.banner) {
          setActiveBanner(body.banner);
        }
      } catch (err) {
        setQaError(
          err instanceof Error ? err.message : "Failed to pin question",
        );
      } finally {
        setIsQaSubmitting(false);
      }
    },
    [targetQaMeetingId, isHost],
  );

  const handleUnpinQuestion = useCallback(async () => {
    if (!targetQaMeetingId || !isHost) return;
    setQaError(null);
    setIsQaSubmitting(true);
    try {
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(targetQaMeetingId)}/qa`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unpin" }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQaError(body?.error ?? "Failed to unpin question");
        return;
      }
      setActiveBanner(null);
    } catch (err) {
      setQaError(
        err instanceof Error ? err.message : "Failed to unpin question",
      );
    } finally {
      setIsQaSubmitting(false);
    }
  }, [targetQaMeetingId, isHost]);

  // Enforce default incoming video cap on join (480p for 1:1 sessions, 720p for webinars/classes).
  useEffect(() => {
    if (
      call &&
      typeof call.setIncomingVideoEnabled === "function" &&
      typeof call.setPreferredIncomingVideoResolution === "function"
    ) {
      applyIncomingVideoSetting(call, defaultIncomingVideoCap);
    }
  }, [call, defaultIncomingVideoCap]);

  const getDashboardUrl = () => {
    if (!session?.user) return "/";

    if (info.organizationId) {
      return `/dashboard/organization/${info.organizationId}/appointments`;
    }

    const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
      session.user;

    if (role === "CONSULTANT" && consultantProfileId) {
      return `/dashboard/consultant/${consultantProfileId}/home`;
    }
    if (role === "CONSULTEE" && consulteeProfileId) {
      return `/dashboard/consultee/${consulteeProfileId}/home`;
    }
    if (role === "STAFF" && staffProfileId) {
      return "/dashboard/staff/support";
    }

    return "/";
  };

  const cleanupAndNavigate = async (targetUrl: string) => {
    setExit("leaving");
    try {
      await leaveCallAndReleaseMedia(call);
    } catch (error) {
      console.error("Error releasing media while leaving call:", error);
    } finally {
      router.push(targetUrl);
    }
  };

  const handleReturnHome = async () => {
    await cleanupAndNavigate(getDashboardUrl());
  };

  if (callEndedAt && !exit) {
    return (
      <CallEnded
        message={
          isHost ? "The call has ended" : "The call has been ended by the host"
        }
        onRejoin={onRejoin}
        onReturnHome={handleReturnHome}
      />
    );
  }

  const advice = exit
    ? {
        tone: "loading" as const,
        title: exit === "ending" ? "Ending the call…" : "Leaving…",
        description:
          exit === "ending"
            ? "Closing the room for everyone and releasing your camera and microphone."
            : "Releasing your camera and microphone.",
        canRejoin: false,
      }
    : describeCallingState(callingState);
  if (advice) {
    return (
      <ConnectionStateScreen
        advice={advice}
        isOffline={callingState === CallingState.OFFLINE}
        onRejoin={onRejoin}
        onLeave={handleReturnHome}
      />
    );
  }

  return (
    <StreamVideoErrorBoundary>
      <section
        data-in-call-chat-blocked={inCallChatAllowed ? "false" : "true"}
        className="relative h-screen w-full overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950"
      >
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMiI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

        <div className="relative flex h-full w-full">
          <div className="flex-1 flex items-center justify-center px-6 pt-16 pb-24">
            <div className="w-full h-full max-w-6xl flex items-center justify-center">
              {awaitingGoLive && !isHost ? (
                <div
                  data-testid="backstage-waiting-room"
                  className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/80 px-8 py-10 text-center backdrop-blur-md"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-400">
                    <Radio className="h-6 w-6 animate-pulse" />
                  </div>
                  <h2 className="text-lg font-semibold text-white">
                    The session will begin shortly
                  </h2>
                  <p className="text-sm text-zinc-400">
                    You are in the waiting room. The stage will appear
                    automatically as soon as the host goes live.
                  </p>
                </div>
              ) : (
                <CallLayout layout={layout} />
              )}
            </div>
          </div>

          {inCallChatAllowed && (
            <StagePinnedBannerOverlay
              banner={activeBanner}
              isHost={isHost}
              onUnpin={handleUnpinQuestion}
              isUpdating={isQaSubmitting}
              error={qaError}
            />
          )}

          <div
            className={cn(
              "fixed right-0 top-0 h-full w-full sm:w-80 bg-zinc-900/95 backdrop-blur-xl border-l border-zinc-800 transform transition-transform duration-300 ease-in-out z-40",
              activeSideTab ? "translate-x-0" : "translate-x-full",
            )}
          >
            <div className="flex items-center justify-between px-3 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-1 rounded-xl bg-zinc-950/70 p-1">
                <button
                  type="button"
                  onClick={() => setActiveSideTab("participants")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                    activeSideTab === "participants"
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>People ({participantCount})</span>
                </button>
                {inCallChatAllowed && (
                  <button
                    type="button"
                    onClick={() => setActiveSideTab("qa")}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                      activeSideTab === "qa"
                        ? "bg-zinc-800 text-white"
                        : "text-zinc-400 hover:text-zinc-200",
                    )}
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    <span>Q&A</span>
                    {questions.length > 0 && (
                      <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-amber-300">
                        {questions.length}
                      </span>
                    )}
                  </button>
                )}
              </div>
              <button
                onClick={() => setActiveSideTab(null)}
                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-zinc-400" />
              </button>
            </div>
            {activeSideTab === "qa" && inCallChatAllowed ? (
              <StageQaDrawer
                questions={questions}
                activeBanner={activeBanner}
                isHost={isHost}
                onAskQuestion={handleAskQuestion}
                onPinQuestion={handlePinQuestion}
                onUnpinQuestion={handleUnpinQuestion}
                isSubmitting={isQaSubmitting}
                error={qaError}
              />
            ) : (
              <div className="h-[calc(100%-60px)] overflow-y-auto">
                <CallParticipantsList onClose={() => setActiveSideTab(null)} />
              </div>
            )}
          </div>

          {activeSideTab && (
            <div
              className="fixed inset-0 bg-black/50 z-30 lg:hidden"
              onClick={() => setActiveSideTab(null)}
            />
          )}
        </div>

        <div className="fixed bottom-0 left-0 right-0 z-50">
          <div className="flex items-center justify-center px-4 py-4">
            <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-3 bg-zinc-900/90 backdrop-blur-xl rounded-2xl border border-zinc-800 shadow-2xl max-w-[calc(100vw-2rem)]">
              <SpeakingWhileMutedNotification>
                <ToggleAudioPublishingButton />
              </SpeakingWhileMutedNotification>

              <ToggleVideoPublishingButton />

              <ReactionsButton />

              <ScreenShareButton />

              {isHost && recordingEnabled && meetingId && (
                <RecordingControls
                  meetingId={meetingId}
                  recordingEnabled={recordingEnabled}
                  showOnlyButton={true}
                  isHost={isHost}
                />
              )}

              <button
                onClick={async () => {
                  await cleanupAndNavigate(getDashboardUrl());
                }}
                className="p-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
                title="Leave call"
              >
                <Phone className="w-5 h-5 rotate-[135deg] text-white" />
              </button>

              <div className="w-px h-8 bg-zinc-700 mx-1" />

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
                          : "text-zinc-400 hover:text-white hover:bg-zinc-800/50",
                      )}
                    >
                      <option.icon className="w-4 h-4" />
                      <span className="text-sm font-medium">
                        {option.label}
                      </span>
                      {layout === option.value && (
                        <div className="ml-auto w-2 h-2 rounded-full bg-white" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <IncomingVideoQualityMenu />

              <CallStatsButton />

              {inCallChatAllowed && (
                <button
                  type="button"
                  title="Live Q&A"
                  data-testid="toggle-qa-drawer"
                  onClick={() =>
                    setActiveSideTab((prev) => (prev === "qa" ? null : "qa"))
                  }
                  className={cn(
                    "p-3 rounded-xl transition-colors relative",
                    activeSideTab === "qa"
                      ? "bg-amber-400 text-zinc-950"
                      : "bg-zinc-800 hover:bg-zinc-700 text-white",
                  )}
                >
                  <MessageSquareText className="w-5 h-5" />
                  {questions.length > 0 && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-amber-400 text-zinc-950 rounded-full text-xs font-semibold flex items-center justify-center">
                      {questions.length}
                    </span>
                  )}
                </button>
              )}

              <button
                onClick={() =>
                  setActiveSideTab((prev) =>
                    prev === "participants" ? null : "participants",
                  )
                }
                className={cn(
                  "p-3 rounded-xl transition-colors relative",
                  activeSideTab === "participants"
                    ? "bg-white text-zinc-900"
                    : "bg-zinc-800 hover:bg-zinc-700 text-white",
                )}
              >
                <Users className="w-5 h-5" />
                {participantCount > 1 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-white text-zinc-900 rounded-full text-xs font-medium flex items-center justify-center">
                    {participantCount}
                  </span>
                )}
              </button>

              <div className="w-px h-8 bg-zinc-700 mx-1" />

              {isHost && meetingId && recordingEnabled && (
                <RecordingControls
                  meetingId={meetingId}
                  recordingEnabled={recordingEnabled}
                  showOnlyIndicator={true}
                  isHost={isHost}
                />
              )}

              {isHost && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="p-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 transition-colors"
                      title="Session options"
                    >
                      <MoreVertical className="w-5 h-5 text-white" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-72 bg-zinc-900 border-zinc-800 p-3 rounded-xl"
                    sideOffset={12}
                  >
                    <p className="text-sm font-medium text-white">
                      End for everyone
                    </p>
                    <p className="mt-1 mb-3 text-xs text-zinc-400">
                      Disconnects every participant and closes the room. Leaving
                      instead only removes you.
                    </p>
                    <EndCallButton onEnding={handleEnding} />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {!isHost && meetingId && recordingEnabled && (
                <RecordingControls
                  meetingId={meetingId}
                  recordingEnabled={recordingEnabled}
                  showOnlyIndicator={true}
                  isHost={false}
                />
              )}
            </div>
          </div>
        </div>

        <div className="pointer-events-none fixed inset-x-4 top-4 z-20 flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 backdrop-blur-sm">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">
                {sessionHeading(info)}
              </p>
              <p className="truncate text-xs text-zinc-500">
                {[
                  info.typeLabel,
                  `${participantCount} participant${participantCount !== 1 ? "s" : ""}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <SessionClockPill startsAt={info.startsAt} endsAt={info.endsAt} />
            <OverrunBanner
              callId={call?.id ?? null}
              startsAt={info.startsAt}
              endsAt={info.endsAt}
              extendedSeconds={info.extendedSeconds}
              extensionsUsed={info.extensionsUsed}
              isHost={isHost}
            />
          </div>
        </div>

        <div className="pointer-events-none fixed inset-x-4 top-20 z-20 flex flex-col items-center gap-2">
          <StageControls
            appointmentType={info.appointmentType}
            isHost={isHost}
          />
          <ConnectionQualityNotice />
        </div>
      </section>
    </StreamVideoErrorBoundary>
  );
};

export default MeetingRoom;
