"use client";

/**
 * A plan the viewer helps deliver: their own terms, the rest of the team by
 * name and role, the schedule, and the way to leave.
 */

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, LogOut } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { bpsToPercent } from "@/lib/collaborators/rules";
import { goHref } from "@/lib/dashboard/go";
import { useFocusFallback } from "./CollaboratorRow";
import { EndCollaborationDialog } from "./EndCollaborationDialog";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";
import { TermsSummary } from "./TermsSummary";
import { formatRole } from "./format";
import type { CollaborationWithPlan, Person } from "./types";

function TeamLine({
  person,
  role,
}: Readonly<{ person: Person; role: string }>) {
  const name = person.name ?? "Unnamed expert";
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-border bg-background px-2.5 py-2">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarImage src={person.image ?? undefined} alt="" />
        <AvatarFallback className="text-xs">{name.charAt(0)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">{role}</p>
      </div>
    </li>
  );
}

export function ActiveCollaborationCard({
  collab,
}: Readonly<{ collab: CollaborationWithPlan }>) {
  const ref = useFocusFallback<HTMLDivElement>();
  const [eventsExpanded, setEventsExpanded] = useState(false);

  const plan = collab.webinarPlan ?? collab.classPlan;
  const owner = plan?.consultantProfile ?? null;
  // The accepted team apart from the viewer. A peer's share is never sent.
  const peers = (plan?.collaborators ?? []).filter(
    (c) => c.id !== collab.id && c.status === "ACCEPTED",
  );
  const eventCount =
    collab.webinarPlan?.webinars.length ??
    collab.classPlan?.classes.length ??
    0;

  return (
    <Card ref={ref} className="border-zinc-200/80 shadow-sm">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge className="rounded-md border-0 bg-teal-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-teal-700">
                {formatRole(collab.role)}
              </Badge>
              <Badge
                variant="secondary"
                className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700"
              >
                {collab.planType === "webinar" ? "Webinar" : "Class"}
              </Badge>
            </div>
            <h3 className="text-base font-semibold tracking-tight text-foreground">
              {collab.planTitle}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {owner?.user.name
                ? `Hosted by ${owner.user.name}`
                : "Hosted by an organisation"}
            </p>
          </div>
          <EndCollaborationDialog
            kind="leave"
            planRef={{ planType: collab.planType, planId: collab.planId }}
            planTitle={collab.planTitle}
            collaboratorId={collab.id}
            personName="You"
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9 shrink-0"
              >
                <LogOut aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                Leave
                <span className="sr-only"> “{collab.planTitle}”</span>
              </Button>
            }
          />
        </div>

        {collab.payoutAccountReady === false && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Your earnings cannot be paid out yet: you have no verified payout
            account.{" "}
            <Link
              href={goHref("expert", "settings/get-paid")}
              className="font-semibold underline"
            >
              Set up payouts
            </Link>
          </p>
        )}

        <TermsSummary
          role={collab.role}
          sharePercent={bpsToPercent(collab.revenueShareBps)}
          audience="collaborator"
          planPricePaise={collab.planPrice}
        />

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Team ({(owner ? 1 : 0) + peers.length + 1})
          </p>
          <ul className="space-y-1.5">
            {owner && <TeamLine person={owner.user} role="Host" />}
            {peers.map((c) => (
              <TeamLine
                key={c.id}
                person={c.consultantProfile.user}
                role={formatRole(c.role)}
              />
            ))}
            <TeamLine
              person={{ name: "You", image: null }}
              role={formatRole(collab.role)}
            />
          </ul>
        </div>

        <div className="rounded-xl border border-border bg-muted/30 px-3 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Schedule
          </p>
          {collab.webinarPlan && (
            <WebinarScheduleSummary plan={collab.webinarPlan} />
          )}
          {collab.classPlan && <ClassScheduleSummary plan={collab.classPlan} />}

          {eventCount > 1 && (
            <div className="mt-2.5 border-t border-border pt-2.5">
              <button
                type="button"
                aria-expanded={eventsExpanded}
                onClick={() => setEventsExpanded((prev) => !prev)}
                className="flex min-h-9 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {eventsExpanded ? (
                  <ChevronUp aria-hidden className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown aria-hidden className="h-3.5 w-3.5" />
                )}
                {eventsExpanded ? "Hide" : "Show"} all events
              </button>
              {eventsExpanded && (
                <div className="mt-2">
                  {collab.webinarPlan && (
                    <WebinarEventList plan={collab.webinarPlan} />
                  )}
                  {collab.classPlan && (
                    <ClassEventList plan={collab.classPlan} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
