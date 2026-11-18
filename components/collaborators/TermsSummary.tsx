"use client";

/**
 * The terms of one collaboration in full: what the role may do, the share with
 * a rupee example at the plan's listed price, the running total against the
 * cap, and when a pending invitation lapses. The invite review, the accept
 * confirmation and the invitation card all read the same words from here.
 */

import type { CollaboratorRole } from "@prisma/client";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  describeRefusal,
  type CollaborationRefusal,
} from "@/hooks/use-collaborations";
import { ROLE_INFO } from "@/lib/collaborators/roles";
import { MAX_TEAM_SHARE_BPS, bpsToPercent } from "@/lib/collaborators/rules";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useZoneClock } from "@/lib/time/use-zone-clock";
import { formatDay, seatSlices } from "./format";

interface TermsSummaryProps {
  role: CollaboratorRole;
  sharePercent: number;
  /** Whose screen this is: a manager reads about "them", a collaborator about "you". */
  audience: "manager" | "collaborator";
  /** The plan's listed seat price in paise; 0 for a free plan. */
  planPricePaise: number;
  /** Manager only: the whole percents the plan's other invited and accepted collaborators hold. */
  otherSharePercents?: readonly number[];
  /** Manager only: true when any of those others is an invitation not yet accepted. */
  othersPending?: boolean;
  /** When the invitation lapses. Omit for someone already on the team. */
  expiresAt?: Date | string | null;
}

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");

function seatExample({
  sharePercent,
  audience,
  planPricePaise,
  otherSharePercents = [],
  othersPending = false,
}: TermsSummaryProps): string {
  if (planPricePaise <= 0) {
    return "This plan is free, so there is nothing to divide unless its price changes.";
  }
  const slices = seatSlices(planPricePaise, sharePercent, otherSharePercents);
  const price = inr(planPricePaise);
  if (audience === "collaborator") {
    return `At the listed price of ${price}, ${inr(slices.collaborator)} of each seat is your share before the platform fee. The fee is then taken from your share at the rate that applies to you.`;
  }
  const others =
    slices.others > 0
      ? `, ${inr(slices.others)} goes to your other collaborators`
      : "";
  // A pending invitation earns nothing until it is accepted, so the example says it counts them.
  const assumption =
    othersPending && slices.others > 0
      ? " These figures assume every pending invitation is accepted."
      : "";
  return `At the listed price of ${price}, ${inr(slices.collaborator)} of each seat is their share${others} and ${inr(slices.host)} stays with you, before the platform fee. The fee is then taken from each share at that person's own rate.${assumption}`;
}

export function TermsSummary(props: Readonly<TermsSummaryProps>) {
  const { role, sharePercent, audience, otherSharePercents, expiresAt } = props;
  const { zone } = useZoneClock();
  const info = ROLE_INFO[role];
  const manager = audience === "manager";
  const pending = expiresAt !== undefined && expiresAt !== null;
  const capPercent = bpsToPercent(MAX_TEAM_SHARE_BPS);
  const teamPercent =
    (otherSharePercents ?? []).reduce((sum, p) => sum + p, 0) + sharePercent;

  return (
    <dl className="space-y-3 text-sm text-foreground">
      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Role
        </dt>
        <dd className="mt-1">
          <p>
            <span className="font-semibold">{info.label}.</span> {info.summary}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {info.can.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </dd>
      </div>

      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Share
        </dt>
        <dd className="mt-1 space-y-1">
          <p>
            <span className="font-semibold">{sharePercent}%</span> of each seat
            sold while {manager ? "they are" : "you are"} on the team.
          </p>
          <p className="text-muted-foreground">{seatExample(props)}</p>
          {pending && (
            <p className="text-muted-foreground">
              {manager
                ? "They earn only on seats sold after they accept."
                : "You earn only on seats sold after you accept."}
            </p>
          )}
        </dd>
      </div>

      {manager && otherSharePercents && (
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Team total
          </dt>
          <dd className="mt-1">
            With this share, collaborators hold {teamPercent}% of this plan
            between them. The limit is {capPercent}%, so you always keep at
            least {100 - capPercent}%.
          </dd>
        </div>
      )}

      {pending && (
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {manager ? "Lapses" : "Answer by"}
          </dt>
          <dd className="mt-1">
            {manager
              ? `The invitation lapses on ${formatDay(expiresAt, zone)} if it has not been answered.`
              : `${formatDay(expiresAt, zone)}. After that the invitation lapses.`}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** A refusal in the server's own sentence, with the way to recover where there is one. */
export function RefusalNotice({
  refusal,
  onReload,
}: Readonly<{
  refusal: CollaborationRefusal | null;
  /** Shown as a Reload button when the refusal means the screen is out of date. */
  onReload?: () => void;
}>) {
  if (!refusal) return null;
  const advice = describeRefusal(refusal);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p>{advice.sentence}</p>
        {advice.reload && onReload && (
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            Reload
          </Button>
        )}
      </div>
    </div>
  );
}
