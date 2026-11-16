"use client";

/**
 * A plan with collaborators, as its manager sees it: what the host keeps, each
 * invited and accepted collaborator with the actions on them, the way to
 * invite another, and the schedule.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCurrencyAmount } from "@/utils/formatting";
import { CollaboratorRow } from "./CollaboratorRow";
import { InviteDialog } from "./InviteDialog";
import { RevenueSplitBar } from "./RevenueSplitBar";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";
import { teamSharePercent } from "./format";
import type { HostedPlanEntry, Person } from "./types";

function HostedPlanScheduleSection({
  plan,
  eventsExpanded,
  hasExpandableDetails,
  onToggleExpanded,
}: Readonly<{
  plan: HostedPlanEntry;
  eventsExpanded: boolean;
  hasExpandableDetails: boolean;
  onToggleExpanded: () => void;
}>) {
  let summaryNode = (
    <p className="text-xs italic text-zinc-400">No schedule data available</p>
  );
  if (plan.planType === "webinar" && plan.webinarPlan) {
    summaryNode = <WebinarScheduleSummary plan={plan.webinarPlan} />;
  } else if (plan.planType === "class" && plan.classPlan) {
    summaryNode = <ClassScheduleSummary plan={plan.classPlan} />;
  }

  let detailsNode: React.ReactNode = null;
  if (eventsExpanded) {
    if (plan.planType === "webinar" && plan.webinarPlan) {
      detailsNode = <WebinarEventList plan={plan.webinarPlan} />;
    } else if (plan.planType === "class" && plan.classPlan) {
      detailsNode = <ClassEventList plan={plan.classPlan} />;
    }
  }

  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/50 px-3 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Schedule
      </p>
      {summaryNode}

      {hasExpandableDetails && (
        <div className="mt-2.5 border-t border-zinc-100 pt-2.5">
          <button
            type="button"
            aria-expanded={eventsExpanded}
            onClick={onToggleExpanded}
            className="flex min-h-9 items-center gap-1 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900"
          >
            {eventsExpanded ? (
              <ChevronUp aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            )}
            {eventsExpanded ? "Hide" : "Show"} all events
          </button>
          {detailsNode && <div className="mt-2">{detailsNode}</div>}
        </div>
      )}
    </div>
  );
}

export function HostedPlanCard({
  plan,
  hostUser,
  hostLabel = "You",
}: Readonly<{
  plan: HostedPlanEntry;
  hostUser?: Person | null;
  /** Whose share the host segment is: the viewer's unless an organisation reads it. */
  hostLabel?: string;
}>) {
  const [eventsExpanded, setEventsExpanded] = useState(false);

  const planRef = { planType: plan.planType, planId: plan.planId };
  const team = plan.collaborators;
  const accepted = team.filter((c) => c.status === "ACCEPTED");
  const pending = team.filter((c) => c.status === "PENDING");
  const teamPercent = teamSharePercent(team);
  const hostPercent = 100 - teamPercent;
  const eventCount =
    plan.webinarPlan?.webinars.length ?? plan.classPlan?.classes.length ?? 0;

  return (
    <Card className="border-zinc-200/80 shadow-sm">
      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge className="rounded-md border-0 bg-zinc-900 px-2 py-0.5 text-xs font-semibold text-white hover:bg-zinc-900">
              Host
            </Badge>
            <Badge
              variant="secondary"
              className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700"
            >
              {plan.planType === "webinar" ? "Webinar" : "Class"}
            </Badge>
          </div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {plan.title}
          </h3>
          {plan.price > 0 && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatCurrencyAmount(plan.price, "INR")} a seat
            </p>
          )}
        </div>

        <div>
          <RevenueSplitBar
            avatar={hostUser}
            segments={[
              { key: "host", percent: hostPercent, className: "bg-zinc-800" },
              {
                key: "collaborators",
                percent: teamPercent,
                className: "bg-teal-500/80",
              },
            ]}
            label={
              <>
                <span className="font-semibold text-zinc-800">
                  {hostLabel} {hostPercent}%
                </span>
                <span className="text-zinc-400"> · </span>
                <span>Collaborators {teamPercent}%</span>
              </>
            }
          />
          {pending.length > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {pending.length === 1
                ? "1 invitation is not answered yet. Its share is held for the invitee and counts only for seats sold after they accept."
                : `${pending.length} invitations are not answered yet. Their shares are held for the invitees and count only for seats sold after each accepts.`}
            </p>
          )}
        </div>

        {/* Takes the focus when a row that held it leaves the list. */}
        <div
          tabIndex={-1}
          role="group"
          aria-label={`Collaborators on ${plan.title}`}
          className="space-y-3 outline-none"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Collaborators ({team.length})
          </p>
          <ul className="space-y-1.5">
            {[...accepted, ...pending].map((member) => (
              <CollaboratorRow
                key={member.id}
                member={member}
                planRef={planRef}
                planTitle={plan.title}
                team={team}
                canManage
              />
            ))}
          </ul>
          <InviteDialog
            planRef={planRef}
            planTitle={plan.title}
            planPricePaise={plan.price}
            team={team}
          />
        </div>

        <HostedPlanScheduleSection
          plan={plan}
          eventsExpanded={eventsExpanded}
          hasExpandableDetails={eventCount > 1}
          onToggleExpanded={() => setEventsExpanded((prev) => !prev)}
        />
      </div>
    </Card>
  );
}
