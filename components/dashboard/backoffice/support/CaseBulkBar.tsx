"use client";

import type { ReactNode } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toneTextClass } from "@/lib/ui/tone";
import type { CaseBulkOutcome } from "@/schemas/support-inbox";
import { cn } from "@/utils/tailwind";

export interface CaseBulkBarProps {
  /** How many rows are ticked. */
  count: number;
  busy: boolean;
  /** The operator's reason; it is written to every affected row's audit row. */
  reason: string;
  onReasonChange: (value: string) => void;
  onAssignToMe: () => void;
  onResolve: () => void;
  onClearSelection: () => void;
  /**
   * The per-row outcome of the last run: some rows succeed and some are
   * refused, and the operator has to be able to read which was which.
   */
  footer?: ReactNode;
}

/**
 * The queue's bulk bar. It sits under the list while a selection exists; the
 * outcome of the last run hangs off it, because a bulk action that answers
 * "done" for a batch where half the rows were refused is a lie.
 */
export function CaseBulkBar({
  count,
  busy,
  reason,
  onReasonChange,
  onAssignToMe,
  onResolve,
  onClearSelection,
  footer,
}: Readonly<CaseBulkBarProps>) {
  return (
    <div className="sticky bottom-0 z-10 space-y-2 border-t border-border bg-card/95 p-2 shadow-[0_-4px_12px_-8px_rgba(0,0,0,0.25)] backdrop-blur">
      <div
        role="region"
        aria-label="Bulk actions"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-sm font-medium text-foreground">
          {count} selected
        </span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Reason
          <Input
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Why? (kept in the audit trail)"
            aria-label="Reason for this bulk action"
            className="h-8 w-56 text-xs"
          />
        </label>
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={busy}
          onClick={onAssignToMe}
        >
          Assign to me
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={busy}
          onClick={onResolve}
        >
          Resolve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8"
          disabled={busy}
          onClick={onClearSelection}
        >
          Clear selection
        </Button>
      </div>
      {footer}
    </div>
  );
}

/** The per-row outcome of a bulk run: what landed, and what was refused. */
export function CaseBulkOutcomes({
  outcomes,
}: Readonly<{ outcomes: CaseBulkOutcome[] }>) {
  if (outcomes.length === 0) return null;
  const failed = outcomes.filter((o) => o.status === "FAILED");
  const done = outcomes.length - failed.length;
  return (
    <div
      role="status"
      aria-live="polite"
      className="max-h-40 overflow-y-auto rounded-md border border-border bg-background px-3 py-2 text-xs"
    >
      <p className="font-medium text-foreground">
        {done} of {outcomes.length} updated
        {failed.length > 0 && (
          <span className="text-destructive"> · {failed.length} refused</span>
        )}
      </p>
      {failed.length > 0 && (
        <ul className="mt-1 space-y-1">
          {failed.map((o) => (
            <li key={o.caseKey} className="flex items-start gap-1.5">
              <XCircle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                aria-hidden
              />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">{o.caseKey}</span>
                {" — "}
                {o.error ?? o.code ?? "refused"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {done > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2
            className={cn("h-3.5 w-3.5 shrink-0", toneTextClass("success"))}
            aria-hidden
          />
          Each updated case has its own audit row.
        </p>
      )}
    </div>
  );
}
