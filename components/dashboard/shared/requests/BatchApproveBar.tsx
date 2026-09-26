"use client";

import { useRef, useState } from "react";
import { AppointmentsType } from "@prisma/client";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { BulkBar } from "@/components/dashboard/BulkBar";
import { Button } from "@/components/ui/button";
import type { AllocationAttemptKey } from "@/hooks/scheduling/useScheduling";
import type { InboxRowInput } from "@/lib/dashboard/requests-inbox-state";
import { cn } from "@/utils/tailwind";

import { approvedToast, errorSentence } from "./labels";
import { approveRequestedTimes } from "./request-decision";

export type BatchOutcome = {
  id: string;
  name: string;
  ok: boolean;
  note: string;
};

/**
 * Approves the selected dialog-free rows one after another through the
 * same allocate PATCH a single approval uses — each call takes its own lock
 * and mints its own pay order, so there is nothing to batch server-side.
 * A 409 is reported and never retried: the row changed under us (#1775).
 */
export function BatchApproveBar({
  rows,
  busy,
  onClear,
  onFinished,
}: Readonly<{
  rows: InboxRowInput[];
  busy: boolean;
  onClear: () => void;
  onFinished: (outcomes: BatchOutcome[]) => void;
}>) {
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<BatchOutcome[]>([]);
  // One idempotency key per row for this run; a retry within the run reuses it.
  const keysRef = useRef(new Map<string, AllocationAttemptKey | null>());

  if (rows.length === 0 && outcomes.length === 0) return null;

  const run = async () => {
    setRunning(true);
    const done: BatchOutcome[] = [];
    for (const row of rows) {
      const ref = { current: keysRef.current.get(row.id) ?? null };
      const result = await approveRequestedTimes(
        {
          id: row.id,
          type:
            row.kind === "subscription"
              ? AppointmentsType.SUBSCRIPTION
              : AppointmentsType.CONSULTATION,
          tentativeSlotCount: row.tentativeSlotCount,
        },
        ref,
        false,
      ).catch((error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      keysRef.current.set(row.id, ref.current);
      const code = "errorCode" in result ? result.errorCode : undefined;
      const failure = errorSentence(code, result.error ?? "Could not approve");
      done.push({
        id: row.id,
        name: row.requester.name,
        ok: result.success,
        note: result.success ? approvedToast(result) : failure,
      });
      setOutcomes([...done]);
    }
    setRunning(false);
    onFinished(done);
  };

  const summary = `${outcomes.filter((o) => o.ok).length} of ${outcomes.length} approved`;
  const idle =
    outcomes.length > 0 && rows.length === 0
      ? summary
      : `${rows.length} selected · requested times only`;
  const status = running
    ? `Approving ${outcomes.length + 1} of ${rows.length}…`
    : idle;

  return (
    <BulkBar
      count={rows.length}
      status={status}
      busy={running}
      onClear={() => {
        setOutcomes([]);
        onClear();
      }}
      aria-label="Batch approval"
      footer={
        outcomes.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs">
            {outcomes.map((o) => (
              <li
                key={o.id}
                className={cn(
                  "flex items-center gap-1.5",
                  o.ok ? "text-foreground" : "text-destructive",
                )}
              >
                {o.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <XCircle className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className="font-medium">{o.name}</span>
                <span>· {o.note}</span>
              </li>
            ))}
          </ul>
        )
      }
    >
      <Button
        size="sm"
        className="min-h-11 sm:min-h-8"
        disabled={running || busy || rows.length === 0}
        onClick={() => void run()}
      >
        {running ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Approving…
          </>
        ) : (
          `Approve ${rows.length}`
        )}
      </Button>
    </BulkBar>
  );
}
