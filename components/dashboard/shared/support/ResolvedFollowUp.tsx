"use client";

import {
  decisionInForce,
  useCaseResolution,
} from "@/components/support/resolution/resolution-data";
import { removalOutcomeCopy } from "@/components/support/resolution/removal-outcome";
import { Button } from "@/components/ui/button";
import { REOPEN_WINDOW_MS } from "@/lib/support/deadline-policy";
import { useZoneClock } from "@/lib/time/use-zone-clock";

/** What a "This didn't fix it" press sends when the customer typed nothing. */
export const REOPEN_MESSAGE = "This didn't fix my problem.";

/** The anchor of the decision and its appeal form on the request page. */
export const CASE_RESOLUTION_ANCHOR = "support-case-resolution";

/**
 * A resolved request takes follow-ups without reopening. An undecided one may
 * be reopened for 14 days; a decided one offers only its appeal, unless it
 * already decides an appeal.
 */
export function ResolvedFollowUp({
  caseId,
  resolvedAt,
  disabled,
  onReopen,
}: Readonly<{
  caseId: string;
  resolvedAt: string | null | undefined;
  disabled: boolean;
  onReopen: () => void;
}>) {
  const resolution = useCaseResolution(caseId);
  const clock = useZoneClock();
  const decision = decisionInForce(resolution.data?.decisions ?? []);
  const appealUntil = decision?.appealUntil
    ? new Date(decision.appealUntil)
    : null;
  const canReopen =
    resolution.isSuccess &&
    !decision &&
    !!resolvedAt &&
    Date.now() - new Date(resolvedAt).getTime() <= REOPEN_WINDOW_MS;
  let action: React.ReactNode = null;
  // A decision on an appeal is final, and one in the learner's favour has nothing to appeal.
  const canAppeal =
    !!resolution.data &&
    !!decision &&
    removalOutcomeCopy(resolution.data, decision.outcome).appealable &&
    appealUntil !== null &&
    appealUntil.getTime() > Date.now();
  if (canAppeal)
    action = (
      <Button variant="outline" size="sm" asChild>
        <a href={`#${CASE_RESOLUTION_ANCHOR}`}>
          Appeal by {clock.date(appealUntil)}
        </a>
      </Button>
    );
  else if (canReopen)
    action = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onReopen}
      >
        This didn&apos;t fix it
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p id="support-reply-follow-up" className="text-xs text-muted-foreground">
        This support case is marked resolved. Your reply won&apos;t reopen it.
      </p>
      {action}
    </div>
  );
}
