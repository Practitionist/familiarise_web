"use client";

import { useEffect, useState } from "react";
import {
  OwnCapability,
  type PermissionRequestEvent,
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { Hand, Radio, Check, X, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  isAwaitingHostGoLive,
  isOneToManyAppointmentType,
} from "@/lib/meetings/room-ready";
import { filterStreamPublishPermissions } from "@/lib/stream/video-contracts";

interface StageControlsProps {
  appointmentType: string | null;
  isHost: boolean;
}

const useDefaultTrue = () => true;
const useDefaultUndefined = () => undefined;

export function StageControls({
  appointmentType,
  isHost,
}: Readonly<StageControlsProps>) {
  const call = useCall();
  const { toast } = useToast();
  const hooks = useCallStateHooks();
  const useIsCallLive = hooks.useIsCallLive ?? useDefaultTrue;
  const useOwnCapabilities = hooks.useOwnCapabilities ?? useDefaultUndefined;
  const useCallSettings = hooks.useCallSettings ?? useDefaultUndefined;

  const isCallLive = useIsCallLive();
  const ownCapabilities = useOwnCapabilities();
  const settings = useCallSettings();

  const [permissionRequests, setPermissionRequests] = useState<
    PermissionRequestEvent[]
  >([]);
  const [isGoingLive, setIsGoingLive] = useState(false);
  const [hasRequestedStage, setHasRequestedStage] = useState(false);

  useEffect(() => {
    if (!call) return;
    const unsubRequest = call.on("call.permission_request", (event) => {
      setPermissionRequests((prev) => {
        const filtered = prev.filter((item) => item.user.id !== event.user.id);
        return [...filtered, event];
      });
    });
    const unsubUpdated = call.on("call.permissions_updated", () => {
      setHasRequestedStage(false);
    });
    return () => {
      unsubRequest?.();
      unsubUpdated?.();
    };
  }, [call]);

  const isOneToMany = isOneToManyAppointmentType(appointmentType);
  const isBackstageEnabled = Boolean(settings?.backstage?.enabled);
  const awaitingGoLive = isAwaitingHostGoLive({
    appointmentType,
    isCallLive,
    isBackstageEnabled,
  });

  const canSendAudio = Boolean(
    ownCapabilities?.includes(OwnCapability.SEND_AUDIO),
  );
  const canSendVideo = Boolean(
    ownCapabilities?.includes(OwnCapability.SEND_VIDEO),
  );
  const needsStageRequest =
    isOneToMany &&
    !isHost &&
    ownCapabilities !== undefined &&
    (!canSendAudio || !canSendVideo);

  useEffect(() => {
    if (canSendAudio && canSendVideo) {
      setHasRequestedStage(false);
    }
  }, [canSendAudio, canSendVideo]);

  const handleGoLive = async () => {
    if (!call || isGoingLive) return;
    setIsGoingLive(true);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(call.id)}/live`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Could not start the live session.");
      }
      toast({
        title: "Session is now live",
        description: "All waiting attendees can now see and hear the stage.",
      });
    } catch (error) {
      toast({
        title: "Could not go live",
        description:
          error instanceof Error
            ? error.message
            : "Please try starting the live session again.",
        variant: "destructive",
      });
    } finally {
      setIsGoingLive(false);
    }
  };

  const handleRequestToSpeak = async () => {
    if (!call) return;
    if (hasRequestedStage) {
      setHasRequestedStage(false);
      toast({
        title: "Hand lowered",
        description: "Your request to speak has been cancelled.",
      });
      return;
    }
    try {
      await call.requestPermissions({
        permissions: [OwnCapability.SEND_AUDIO, OwnCapability.SEND_VIDEO],
      });
      setHasRequestedStage(true);
      toast({
        title: "Hand raised",
        description: "The host has been notified of your request to speak.",
      });
    } catch (error) {
      toast({
        title: "Request failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not request stage permissions.",
        variant: "destructive",
      });
    }
  };

  const updateStagePermissionsViaServer = async (
    targetUserId: string,
    action: "grant" | "revoke",
    rawPermissions: OwnCapability[],
  ) => {
    if (!call) return;
    const validPermissions = filterStreamPublishPermissions(
      rawPermissions.map(String),
    );
    const permissions =
      validPermissions.length > 0
        ? validPermissions
        : (["send-audio", "send-video"] as const);

    const response = await fetch(
      `/api/meetings/${encodeURIComponent(call.id)}/stage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetUserId,
          action,
          permissions,
        }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        body.error ||
          (action === "grant"
            ? "Could not grant permissions"
            : "Could not decline request"),
      );
    }
  };

  const handleApproveRequest = async (
    userId: string,
    permissions: OwnCapability[],
  ) => {
    if (!call) return;
    try {
      await updateStagePermissionsViaServer(userId, "grant", permissions);
      setPermissionRequests((prev) =>
        prev.filter((item) => item.user.id !== userId),
      );
    } catch (error) {
      toast({
        title: "Could not grant permissions",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDenyRequest = async (
    userId: string,
    permissions: OwnCapability[],
  ) => {
    if (!call) return;
    try {
      await updateStagePermissionsViaServer(userId, "revoke", permissions);
      setPermissionRequests((prev) =>
        prev.filter((item) => item.user.id !== userId),
      );
    } catch (error) {
      toast({
        title: "Could not decline request",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  if (
    !awaitingGoLive &&
    !needsStageRequest &&
    !(isHost && permissionRequests.length > 0)
  ) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto flex flex-col items-center gap-2"
      data-testid="stage-controls"
    >
      {awaitingGoLive && (
        <div
          className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-zinc-900/95 px-4 py-2.5 text-sm text-white shadow-xl backdrop-blur-md"
          data-testid="backstage-banner"
        >
          <Radio className="h-4 w-4 shrink-0 text-amber-400 animate-pulse" />
          {isHost ? (
            <>
              <span className="text-zinc-200">
                You are in backstage mode. Attendees are waiting for you to
                start.
              </span>
              <button
                type="button"
                onClick={handleGoLive}
                disabled={isGoingLive}
                data-testid="go-live-button"
                className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                {isGoingLive ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radio className="h-3.5 w-3.5" />
                )}
                Go Live
              </button>
            </>
          ) : (
            <span className="text-amber-200">
              Waiting for host to start the live session...
            </span>
          )}
        </div>
      )}

      {needsStageRequest && !awaitingGoLive && (
        <button
          type="button"
          onClick={handleRequestToSpeak}
          data-testid="raise-hand-button"
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/90 px-3.5 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-md transition-colors hover:bg-zinc-800"
        >
          <Hand className="h-3.5 w-3.5 text-amber-400" />
          {hasRequestedStage
            ? "Hand Raised · Click to Lower Hand"
            : "Raise Hand / Request to Speak"}
        </button>
      )}

      {isHost && permissionRequests.length > 0 && (
        <div
          className="flex flex-col gap-2 rounded-xl border border-zinc-700 bg-zinc-900/95 p-3 text-xs text-white shadow-xl backdrop-blur-md"
          data-testid="permission-requests-popover"
        >
          <p className="font-semibold text-zinc-200">
            Stage Requests ({permissionRequests.length})
          </p>
          {permissionRequests.map((req) => (
            <div
              key={req.user.id}
              className="flex items-center justify-between gap-3 rounded-lg bg-zinc-800/80 px-2.5 py-1.5"
            >
              <span className="truncate font-medium text-white">
                {req.user.name || req.user.id} wants to speak
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    handleApproveRequest(
                      req.user.id,
                      req.permissions as OwnCapability[],
                    )
                  }
                  className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-white hover:bg-emerald-500"
                  title="Approve stage request"
                >
                  <Check className="h-3 w-3" />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleDenyRequest(
                      req.user.id,
                      req.permissions as OwnCapability[],
                    )
                  }
                  className="inline-flex items-center gap-1 rounded bg-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-600"
                  title="Decline stage request"
                >
                  <X className="h-3 w-3" />
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
