"use client";

/**
 * Host-perspective card: one of the current consultant's own plans that
 * has collaborators on it. Extracted verbatim from InvitationsPanel.tsx.
 */

import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatCurrencyFromMajorUnit } from "@/utils/formatting";
import type { HostedPlanEntry } from "./types";
import { COLLABORATOR_STATUS_BADGE, formatRole } from "./format";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";

export function HostedPlanCard({
  plan,
  hostUser,
}: {
  plan: HostedPlanEntry;
  hostUser?: { name: string | null; image: string | null };
}) {
  const [eventsExpanded, setEventsExpanded] = useState(false);

  const totalCollabShare =
    plan.collaborators
      .filter((c) => c.status === "PENDING" || c.status === "ACCEPTED")
      .reduce((sum, c) => sum + c.revenueShareBps, 0) / 100;
  const hostShare = 100 - totalCollabShare;

  const pendingCollabs = plan.collaborators.filter(
    (c) => c.status === "PENDING",
  );
  const acceptedCollabs = plan.collaborators.filter(
    (c) => c.status === "ACCEPTED",
  );

  const hasExpandableDetails =
    (plan.planType === "webinar" &&
      plan.webinarPlan &&
      plan.webinarPlan.webinars.length > 1) ||
    (plan.planType === "class" &&
      plan.classPlan &&
      plan.classPlan.classes.length > 1);

  return (
    <Card className="overflow-hidden">
      {/* Role banner */}
      <div className="bg-zinc-800 px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-white tracking-wide uppercase">
          Host
        </span>
        <Badge
          variant="secondary"
          className="text-[10px] bg-zinc-700 text-zinc-200 border-zinc-600"
        >
          {plan.planType === "webinar" ? "Webinar" : "Class"}
        </Badge>
      </div>

      <div className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-800 truncate">
              {plan.title}
            </p>
            {plan.price > 0 && (
              <p className="text-xs text-zinc-500">
                {formatCurrencyFromMajorUnit(plan.price, "INR")}
              </p>
            )}
          </div>
        </div>

        {/* Revenue split */}
        <div className="flex items-center gap-2 mt-2 px-2 py-1.5 bg-zinc-50 rounded-md border border-zinc-100">
          <div className="flex items-center gap-1.5 text-xs text-zinc-600">
            {hostUser && (
              <Avatar className="w-5 h-5">
                <AvatarImage src={hostUser.image ?? undefined} />
                <AvatarFallback className="text-[8px]">
                  {(hostUser.name ?? "H").charAt(0)}
                </AvatarFallback>
              </Avatar>
            )}
            <span className="font-medium">You {hostShare}%</span>
            <span>&middot; Collaborators {totalCollabShare}%</span>
          </div>
        </div>

        {/* Collaborators list */}
        <div className="border-t border-zinc-100 mt-3 pt-3">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
            Collaborators ({plan.collaborators.length})
          </p>
          <div className="space-y-2">
            {[...acceptedCollabs, ...pendingCollabs].map((collab) => (
              <div
                key={collab.id}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2.5">
                  <Avatar className="w-7 h-7">
                    <AvatarImage
                      src={collab.consultantProfile.user.image ?? undefined}
                    />
                    <AvatarFallback className="text-[10px]">
                      {(collab.consultantProfile.user.name ?? "?").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-xs font-medium text-zinc-800">
                      {collab.consultantProfile.user.name ?? "Unknown"}
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      {formatRole(collab.role)} &middot;{" "}
                      {collab.revenueShareBps / 100}% share
                    </p>
                  </div>
                </div>
                <StatusBadge
                  size="sm"
                  {...COLLABORATOR_STATUS_BADGE[collab.status]}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Schedule summary */}
        <div className="border-t border-zinc-100 mt-3 pt-3">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
            Schedule
          </p>
          {plan.planType === "webinar" && plan.webinarPlan ? (
            <WebinarScheduleSummary plan={plan.webinarPlan} />
          ) : plan.planType === "class" && plan.classPlan ? (
            <ClassScheduleSummary plan={plan.classPlan} />
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
              onClick={() => setEventsExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
            >
              {eventsExpanded ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              {eventsExpanded ? "Hide" : "Show"} all events
            </button>
            {eventsExpanded && (
              <div className="mt-2 border-t border-zinc-100 pt-2">
                {plan.planType === "webinar" && plan.webinarPlan ? (
                  <WebinarEventList plan={plan.webinarPlan} />
                ) : plan.planType === "class" && plan.classPlan ? (
                  <ClassEventList plan={plan.classPlan} />
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
