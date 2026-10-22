"use client";

import { useCaseResolution } from "@/components/support/resolution/resolution-data";
import { Button } from "@/components/ui/button";
import { REOPEN_WINDOW_MS } from "@/lib/support/deadline-policy";
import { formatDateLabel } from "@/lib/time/display";

/** What a "This didn't fix it" press sends when the customer typed nothing. */
export const REOPEN_MESSAGE = "This didn't fix my problem.";

/** The anchor of the decision and its appeal form on the request page. */
export const CASE_RESOLUTION_ANCHOR = "support-case-resolution";

/**
 * A resolved request takes follow-ups without reopening. An undecided one may
 * be reopened for 14 days; a decided one offers only its appeal.
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
  const decisions = resolution.data?.decisions ?? [];
  const decision = decisions[decisions.length - 1];
  const appealUntil = decision?.appealUntil
    ? new Date(decision.appealUntil)
    : null;
  const canReopen =
    resolution.isSuccess &&
    !decision &&
    !!resolvedAt &&
    Date.now() - new Date(resolvedAt).getTime() <= REOPEN_WINDOW_MS;
  let action: React.ReactNode = null;
  if (appealUntil && appealUntil.getTime() > Date.now())
    action = (
      <Button variant="outline" size="sm" asChild>
        <a href={`#${CASE_RESOLUTION_ANCHOR}`}>
          Appeal by {formatDateLabel(appealUntil)}
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
        This request is marked resolved. Your reply won&apos;t reopen it.
      </p>
      {action}
    </div>
  );
}
