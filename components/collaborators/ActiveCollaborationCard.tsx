"use client";

/**
 * Collaborator-perspective card: a plan the current consultant was invited
 * onto and has accepted. Extracted verbatim from InvitationsPanel.tsx.
 * Requires an ancestor <TooltipProvider> (the panel provides it).
 */

import { useState } from "react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CollaborationWithPlan } from "./types";
import {
  COLLABORATOR_STATUS_BADGE,
  ROLE_DESCRIPTIONS,
  formatRole,
} from "./format";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";

export function ActiveCollaborationCard({
  collab,
  currentUser,
}: {
  collab: CollaborationWithPlan;
  currentUser?: { name: string | null; image: string | null };
}) {
  const [slotsExpanded, setSlotsExpanded] = useState(false);

  const owner =
    collab.planType === "webinar"
      ? collab.webinarPlan?.consultantProfile
      : collab.classPlan?.consultantProfile;

  // Filter out the current user from the collaborators list (they're shown in the banner)
  const allCollaboratorsOnPlan =
    (collab.planType === "webinar"
      ? collab.webinarPlan?.collaborators
      : collab.classPlan?.collaborators) ?? [];
  const otherCollaborators = allCollaboratorsOnPlan.filter(
    (c) => c.id !== collab.id,
  );

  const hasExpandableDetails =
    (collab.planType === "webinar" &&
      collab.webinarPlan &&
      collab.webinarPlan.webinars.length > 1) ||
    (collab.planType === "class" &&
      collab.classPlan &&
      collab.classPlan.classes.length > 1);

  return (
    <Card className="overflow-hidden">
      {/* Role banner */}
      <div className="bg-purple-600 px-3 py-1.5 flex items-center justify-between">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs font-semibold text-white tracking-wide uppercase cursor-help">
              {formatRole(collab.role)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>{ROLE_DESCRIPTIONS[collab.role] ?? formatRole(collab.role)}</p>
          </TooltipContent>
        </Tooltip>
        <Badge
          variant="secondary"
          className="text-[10px] bg-purple-500 text-purple-100 border-purple-400"
        >
          {collab.planType === "webinar" ? "Webinar" : "Class"}
        </Badge>
      </div>

      <div className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            {owner?.id ? (
              <Link
                href={`/dashboard/consultant/${owner.id}/planner`}
                className="text-sm font-medium text-zinc-800 truncate hover:underline block"
              >
                {collab.planTitle}
              </Link>
            ) : (
              <p className="text-sm font-medium text-zinc-800 truncate">
                {collab.planTitle}
              </p>
            )}
            <p className="text-xs text-zinc-500">
              by {owner?.user.name ?? "Unknown"}
            </p>
          </div>
        </div>

        {/* Revenue share */}
        <div className="flex items-center gap-2 mt-2 px-2 py-1.5 bg-zinc-50 rounded-md border border-zinc-100">
          <div className="flex items-center gap-1.5 text-xs text-zinc-600">
            {currentUser && (
              <Avatar className="w-5 h-5">
                <AvatarImage src={currentUser.image ?? undefined} />
                <AvatarFallback className="text-[8px]">
                  {(currentUser.name ?? "Y").charAt(0)}
                </AvatarFallback>
              </Avatar>
            )}
            <span className="font-medium">
              You {collab.revenueShareBps / 100}%
            </span>
            {owner && (
              <span>
                &middot; {owner.user.name} {100 - collab.revenueShareBps / 100}
                %
              </span>
            )}
          </div>
        </div>

        {/* Team — host + self + other collaborators */}
        <div className="border-t border-zinc-100 mt-3 pt-3">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
            Team ({2 + otherCollaborators.length})
          </p>
          <div className="space-y-2">
            {/* Host (plan owner) */}
            {owner && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Avatar className="w-7 h-7">
                    <AvatarImage src={owner.user.image ?? undefined} />
                    <AvatarFallback className="text-[10px]">
                      {(owner.user.name ?? "H").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-xs font-medium text-zinc-800">
                      {owner.user.name ?? "Unknown"}
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      Host &middot;{" "}
                      {100 -
                        allCollaboratorsOnPlan.reduce(
                          (sum, c) => sum + c.revenueShareBps,
                          0,
                        ) /
                          100}
                      % share
                    </p>
                  </div>
                </div>
                <Badge
                  variant="default"
                  className="bg-zinc-100 text-zinc-700 border-zinc-200 text-[10px]"
                >
                  Owner
                </Badge>
              </div>
            )}
            {/* Other collaborators (not the current user) */}
            {otherCollaborators.map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Avatar className="w-7 h-7">
                    <AvatarImage
                      src={c.consultantProfile.user.image ?? undefined}
                    />
                    <AvatarFallback className="text-[10px]">
                      {(c.consultantProfile.user.name ?? "?").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-xs font-medium text-zinc-800">
                      {c.consultantProfile.user.name ?? "Unknown"}
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      {formatRole(c.role)} &middot; {c.revenueShareBps / 100}%
                      share
                    </p>
                  </div>
                </div>
                <StatusBadge size="sm" {...COLLABORATOR_STATUS_BADGE[c.status]} />
              </div>
            ))}
          </div>
        </div>

        {/* Schedule summary */}
        <div className="border-t border-zinc-100 mt-3 pt-3">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
            Schedule
          </p>
          {collab.planType === "webinar" && collab.webinarPlan ? (
            <WebinarScheduleSummary plan={collab.webinarPlan} />
          ) : collab.planType === "class" && collab.classPlan ? (
            <ClassScheduleSummary plan={collab.classPlan} />
          ) : (
            <p className="text-xs text-zinc-400 italic">
              No schedule data available
            </p>
          )}
        </div>

        {/* All events — collapsible */}
        {hasExpandableDetails && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setSlotsExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
            >
              {slotsExpanded ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              {slotsExpanded ? "Hide" : "Show"} all events
            </button>
            {slotsExpanded && (
              <div className="mt-2 border-t border-zinc-100 pt-2">
                {collab.planType === "webinar" && collab.webinarPlan ? (
                  <WebinarEventList plan={collab.webinarPlan} />
                ) : collab.planType === "class" && collab.classPlan ? (
                  <ClassEventList plan={collab.classPlan} />
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
