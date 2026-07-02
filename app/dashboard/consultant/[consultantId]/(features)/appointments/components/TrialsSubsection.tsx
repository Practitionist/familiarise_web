"use client";

import { Gift, Loader2, Video } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  ScheduledTrial,
  SectionQueryState,
} from "../../../types";

interface TrialsSubsectionProps {
  trials: ScheduledTrial[];
  joiningTrialId: string | null;
  onJoin: (trial: ScheduledTrial) => void;
  /** Query state for this section — renders its own skeleton/error inline. */
  state?: SectionQueryState;
}

// Joinable within 10 mins before start and until the slot ends.
function isTrialJoinable(trial: ScheduledTrial): boolean {
  if (!trial.appointment?.slotsOfAppointment?.[0]) return false;
  const slot = trial.appointment.slotsOfAppointment[0];
  const now = new Date();
  const startTime = new Date(slot.startsAt);
  const endTime = slot.endsAt
    ? new Date(slot.endsAt)
    : new Date(startTime.getTime() + 60 * 60 * 1000);
  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return false;
  const joinWindowStart = new Date(startTime.getTime() - 10 * 60 * 1000);
  return now >= joinWindowStart && now <= endTime;
}

function formatTrialTime(dateString: string) {
  return new Date(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * "Free Trial Sessions" block embedded at the top of the SUBSCRIPTION
 * section of the appointments list. Owns its own loading/error rendering
 * so a slow trials query can't blank the rest of the page.
 */
export function TrialsSubsection({
  trials,
  joiningTrialId,
  onJoin,
  state,
}: TrialsSubsectionProps) {
  if (state?.isLoading) {
    return (
      <div className="mb-6 rounded-lg border border-purple-200 bg-purple-50/50 p-4">
        <Skeleton className="h-4 w-44 mb-3" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    );
  }

  if (state?.isError) {
    return (
      <div className="mb-6 rounded-lg border border-purple-200 bg-purple-50/50 p-4 flex items-center justify-between gap-3">
        <p className="text-sm text-purple-800">
          Couldn&apos;t load your trial sessions.
        </p>
        <Button variant="outline" size="sm" onClick={state.onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (trials.length === 0) return null;

  return (
    <div className="mb-6 bg-purple-50/50 border border-purple-200 rounded-lg p-4">
      <h4 className="text-sm font-semibold text-purple-700 mb-3 flex items-center gap-2">
        <Gift className="h-4 w-4" />
        Free Trial Sessions ({trials.length})
      </h4>
      <div className="space-y-3">
        {trials.map((trial) => (
          <div
            key={trial.id}
            className="border border-purple-200 rounded-lg p-4 bg-purple-50/50"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage
                    src={trial.consulteeProfile.user.image || ""}
                    alt={trial.consulteeProfile.user.name}
                  />
                  <AvatarFallback>
                    {trial.consulteeProfile.user.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium text-zinc-900">
                    {trial.consulteeProfile.user.name}
                  </p>
                  <p className="text-sm text-zinc-600">
                    {trial.subscriptionPlan.title} •{" "}
                    {trial.subscriptionPlan.freeTrialDurationMinutes} min trial
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <Badge className="bg-purple-100 text-purple-900 border-purple-200">
                    Trial
                  </Badge>
                  {trial.appointment?.slotsOfAppointment?.[0] && (
                    <p className="text-xs text-zinc-500 mt-1">
                      {formatTrialTime(
                        trial.appointment.slotsOfAppointment[0].startsAt,
                      )}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => onJoin(trial)}
                  disabled={
                    joiningTrialId === trial.id || !isTrialJoinable(trial)
                  }
                  className={
                    isTrialJoinable(trial)
                      ? "bg-purple-600 hover:bg-purple-700"
                      : ""
                  }
                >
                  {joiningTrialId === trial.id ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      Joining...
                    </>
                  ) : (
                    <>
                      <Video className="h-4 w-4 mr-1" />
                      Join
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
