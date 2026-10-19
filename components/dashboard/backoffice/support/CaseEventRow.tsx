"use client";

import { humanizeEnum } from "@/lib/ui/tone";
import type { CaseHistoryEvent } from "@/types/support-case";

/**
 * One line of the case's audit trail, in the operator's words: what happened,
 * who did it, and what it changed. The event's own values are the machine's
 * (a status, a priority, an assignee id), so they are translated here rather
 * than printed raw.
 */
export function caseEventCopy(event: CaseHistoryEvent): string {
  const actor = event.actorName ?? "The system";
  const from = event.fromValue ? humanizeEnum(event.fromValue) : null;
  const to = event.toValue ? humanizeEnum(event.toValue) : null;
  switch (event.kind) {
    case "CREATED":
      return "Case created";
    case "STATUS_CHANGED":
      return from && to ? `Status changed: ${from} → ${to}` : "Status changed";
    case "PRIORITY_CHANGED":
      return from && to
        ? `Priority changed: ${from} → ${to}`
        : "Priority changed";
    case "ASSIGNED":
      return `${actor} assigned this case`;
    case "UNASSIGNED":
      return `${actor} unassigned this case`;
    case "VISIBILITY_CHANGED":
      return "Visibility changed";
    case "LINKED_PROBLEM":
      return "Linked to a problem case";
    case "DUPLICATE_CLOSED":
      return "Closed as a duplicate";
    case "REOPENED":
      return `${actor} reopened this case`;
    case "AUTO_CLOSED":
      return "Closed automatically";
    case "CSAT_RATED":
      return "The customer rated this case";
    default:
      return humanizeEnum(event.kind);
  }
}

/**
 * A system event in the conversation column: visually distinct from what the
 * customer wrote, so the transcript and the audit trail never read as one
 * stream of messages.
 */
export function CaseEventRow({ event }: Readonly<{ event: CaseHistoryEvent }>) {
  const at = new Date(event.createdAt).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="flex items-start gap-2 py-0.5 text-xs text-muted-foreground">
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border"
        aria-hidden
      />
      <p className="min-w-0">
        <span className="sr-only">System event: </span>
        <span className="font-medium text-foreground">
          {caseEventCopy(event)}
        </span>
        {event.note && <span className="italic"> — {event.note}</span>}
        <span aria-hidden> · {at}</span>
      </p>
    </div>
  );
}
