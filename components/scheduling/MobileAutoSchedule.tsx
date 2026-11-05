"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { AllocationService } from "@/lib/scheduling/allocationService";
import {
  autoScheduled,
  partiallyScheduled,
} from "@/lib/scheduling/allocationMessages";

/**
 * The phone's allocation door: the server places this booking's open sessions
 * in the consultant's published hours (the same auto mode as the desktop
 * button), so a reminder tapped on a phone is not a dead end.
 */
export function MobileAutoSchedule({
  eventType,
  eventId,
  initialAllocation,
  topUp,
  onDone,
}: Readonly<{
  eventType: "consultation" | "subscription";
  eventId: string;
  initialAllocation?: boolean;
  /** The plan already holds sessions: append the open week, never re-plan. */
  topUp?: boolean;
  onDone: () => void;
}>) {
  const [busy, setBusy] = useState(false);
  const autoLabel =
    eventType === "subscription" ? "Auto-schedule this week" : "Auto-schedule";
  const [refusal, setRefusal] = useState<string | null>(null);
  // One key per attempt: a double tap replays the first batch.
  const attemptKeyRef = useRef<string | null>(null);

  const run = async () => {
    setBusy(true);
    setRefusal(null);
    attemptKeyRef.current ??= globalThis.crypto.randomUUID();
    try {
      const response = await AllocationService.allocateSlots(
        eventType,
        eventId,
        [],
        {
          isAuto: true,
          idempotencyKey: attemptKeyRef.current,
          initialAllocation,
          topUp,
          allowPartial: topUp,
        },
      );
      // Only a success or a 4xx refusal is definite and spends the key; a
      // 5xx or an unreadable 2xx may have committed, so a retry replays it.
      const status = response.httpStatus ?? 500;
      if (response.success || (status >= 400 && status < 500)) {
        attemptKeyRef.current = null;
      }
      if (!response.success) {
        setRefusal(
          response.error ??
            "We couldn't place the times just now. Try again, or pick them on a computer.",
        );
        return;
      }
      toast(
        response.partial
          ? partiallyScheduled(
              response.placedSessions ?? 0,
              response.requiredSessions ?? 0,
            )
          : autoScheduled(),
      );
      onDone();
    } catch {
      setRefusal(
        "We couldn't reach the server. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-2">
      <Button className="min-h-11 w-full" disabled={busy} onClick={run}>
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Scheduling…
          </>
        ) : (
          autoLabel
        )}
      </Button>
      <p className="text-xs text-muted-foreground">
        We pick free times in your published hours and tell your client.
      </p>
      {refusal ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
