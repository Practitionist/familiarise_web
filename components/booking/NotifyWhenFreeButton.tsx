"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fetchBackupInterest } from "@/lib/booking/interest/backup-interest-list";
import { CONSULTEE_BACKUP_INTEREST_QUERY_KEY } from "@/lib/booking/interest/query-keys";
import type { BackupInterestEntry } from "@/schemas/interest";
import { cn } from "@/utils/tailwind";

import { assertOk } from "./NotifyToggleButton";

/** The refusal codes that mean "someone else holds this window". */
export const HELD_BY_SOMEONE_ELSE = new Set(["SLOT_TAKEN", "LOCK_CONTENTION"]);

export interface BackupWindowRequest {
  consultantProfileId: string;
  windowStart: string;
  windowEnd: string;
  planKind: "CONSULTATION" | "SUBSCRIPTION";
  planId?: string | null;
}

const registeredSchema = z.object({
  data: z.object({ id: z.string(), status: z.string() }),
});

/**
 * "Notify me" on a taken 1:1 time, or "Waiting" with a withdraw once the
 * learner waits on it. Notify-only: nothing is held, the first to book gets
 * it. A refusal (the cap of three) shows under the button.
 */
export function NotifyWhenFreeButton({
  window,
  timeLabel,
  onSignIn,
  errorClassName,
}: Readonly<{
  window: BackupWindowRequest;
  /** The time as the row shows it, for the buttons' names. */
  timeLabel: string;
  /** Set for a signed-out visitor: "Notify me" sends them to sign in. */
  onSignIn?: () => void;
  errorClassName?: string;
}>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const signedIn = onSignIn === undefined;
  const list = useQuery({
    queryKey: CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
    queryFn: fetchBackupInterest,
    staleTime: 60_000,
    enabled: signedIn,
  });
  const startMs = Date.parse(window.windowStart);
  const entry = list.data?.find(
    (row) =>
      row.consultantProfileId === window.consultantProfileId &&
      Date.parse(row.windowStart) === startMs,
  );
  // The answer lands in the list at once, so a failed re-read keeps it.
  const updateList = (
    change: (rows: BackupInterestEntry[]) => BackupInterestEntry[],
  ) => {
    queryClient.setQueryData<BackupInterestEntry[]>(
      CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
      (rows) => change(rows ?? []),
    );
    void queryClient.invalidateQueries({
      queryKey: CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
    });
  };

  const join = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/scheduling/backup-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(window),
      });
      await assertOk(res);
      return registeredSchema.parse(await res.json()).data;
    },
    onSuccess: (row) => {
      setError(null);
      toast({
        title: "We'll tell you the moment it frees",
        description: "Nothing is held for you — the first to book gets it.",
      });
      updateList((rows) => [
        ...rows.filter((r) => r.id !== row.id),
        { ...window, id: row.id, status: row.status },
      ]);
    },
    onError: (refusal: Error) => setError(refusal.message),
  });
  const withdraw = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/scheduling/backup-interest?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      await assertOk(res);
    },
    onSuccess: (_answer, id) => {
      setError(null);
      toast({ title: "Notification removed" });
      updateList((rows) => rows.filter((r) => r.id !== id));
    },
    onError: (refusal: Error) => setError(refusal.message),
  });
  const busy = join.isPending || withdraw.isPending;

  return (
    <div className="space-y-1">
      {entry ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-medium">
            <BellRing aria-hidden="true" className="h-3.5 w-3.5" />
            Waiting
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Withdraw: stop waiting on ${timeLabel}`}
            onClick={() => withdraw.mutate(entry.id)}
          >
            Withdraw
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || (signedIn && list.isPending)}
          aria-label={`Notify me if ${timeLabel} opens`}
          onClick={() => (onSignIn ? onSignIn() : join.mutate())}
        >
          <BellRing aria-hidden="true" className="mr-1.5 h-4 w-4" />
          Notify me
        </Button>
      )}
      {list.isError && !list.data && (
        <button
          type="button"
          onClick={() => void list.refetch()}
          className="text-xs underline underline-offset-2"
        >
          Couldn&apos;t check your waiting list. Retry
        </button>
      )}
      {error && (
        <p role="alert" className={cn("text-xs", errorClassName)}>
          {error}
        </p>
      )}
    </div>
  );
}
