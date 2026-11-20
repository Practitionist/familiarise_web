"use client";

/**
 * The Collaborators tab of a saved webinar or class: who is invited or on the
 * team, what the host keeps, and the way to invite. A failed load says so and
 * offers to try again; it never reads as an empty team.
 */

import { AlertTriangle, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/DataCard";
import { usePlanTeam } from "@/hooks/use-collaborations";
import { CollaboratorRow } from "./CollaboratorRow";
import { InviteDialog } from "./InviteDialog";
import { teamSharePercent } from "./format";
import type { PlanType } from "./types";

export function CollaboratorsTab({
  planType,
  planId,
  planTitle,
  planPricePaise,
}: Readonly<{
  planType: PlanType;
  planId: string;
  planTitle: string;
  /** The saved seat price, for the rupee example in the invitation review. */
  planPricePaise: number;
}>) {
  const planRef = { planType, planId };
  const team = usePlanTeam(planRef);

  if (team.isPending) {
    return (
      <div role="status" className="flex items-center justify-center py-8">
        <Loader2 aria-hidden className="h-6 w-6 animate-spin text-zinc-400" />
        <span className="sr-only">Loading collaborators</span>
      </div>
    );
  }

  if (team.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load this plan's collaborators"
        description={team.error.message}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => team.refetch()}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const { members, canManage, viewer } = team.data;
  const pendingCount = members.filter((c) => c.status === "PENDING").length;
  const teamPercent = teamSharePercent(members);

  return (
    // Takes the focus when a row that held it leaves the list.
    <div
      tabIndex={-1}
      role="group"
      aria-label="Collaborators on this plan"
      className="space-y-4 outline-none"
    >
      {viewer === "manager" && (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          <span className="font-medium">
            You keep {100 - teamPercent}% of each seat.
          </span>{" "}
          {members.length === 0
            ? "Nobody else shares in this plan."
            : `Collaborators hold ${teamPercent}% between them.`}
          {pendingCount > 0 &&
            (pendingCount === 1
              ? " 1 invitation is not answered yet; its share counts only for seats sold after it is accepted."
              : ` ${pendingCount} invitations are not answered yet; their shares count only for seats sold after each is accepted.`)}
        </p>
      )}

      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No collaborators yet"
          description={
            canManage
              ? "Invite another verified expert to help deliver this plan."
              : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {members.map((member) => (
            <CollaboratorRow
              key={member.id}
              member={member}
              planRef={planRef}
              planTitle={planTitle}
              team={members}
              canManage={canManage}
            />
          ))}
        </ul>
      )}

      {canManage && (
        <InviteDialog
          planRef={planRef}
          planTitle={planTitle}
          planPricePaise={planPricePaise}
          team={members}
        />
      )}
      {viewer === "manager" && !canManage && (
        <p className="text-sm text-muted-foreground">
          This organisation is not active, so this plan&apos;s team cannot
          change.
        </p>
      )}
    </div>
  );
}
