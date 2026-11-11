"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { useToast } from "@/hooks/use-toast";
import {
  RETURN_BLOCK_COPY,
  RETURN_CAP,
  RETURN_CONFIRM_COPY,
  returnBlock,
} from "@/lib/booking/session-return-rules";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { lastInstantBefore } from "@/lib/booking/entitlement";
import { formatForViewer } from "@/lib/time/viewer-zone";

import {
  SessionConfirmDialog,
  type PendingConfirm,
} from "./SessionConfirmDialog";
import type { SessionRowAction } from "./SessionSchedule";

interface ReturnableSessionRow {
  id: string;
  startsAt: Date | string;
  completionStatus: string | null;
  isTentative?: boolean | null;
  deletedAt?: Date | string | null;
}

const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

async function postReturn(appointmentId: string, occurrenceId: string) {
  const res = await fetch(
    `/api/appointments/${appointmentId}/occurrences/${occurrenceId}/return`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: "{}",
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    planEndsAt?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

/**
 * D8 — the consultee's "Return to plan" on each upcoming subscription session,
 * offered on that session's row. A blocked return stays in the menu with the
 * reason under it; the confirm states the rule before anything moves, and
 * the footnote names the rule and how many returns are left.
 */
export function useSubscriptionReturnActions({
  appointmentId,
  sessions,
  sessionsReturned,
  rescheduleOpen,
  onChanged,
  enabled,
}: Readonly<{
  appointmentId: string;
  sessions: ReturnableSessionRow[];
  sessionsReturned: number;
  rescheduleOpen: boolean;
  onChanged: () => void;
  /** False for anyone but the paying consultee of a live plan. */
  enabled: boolean;
}>): {
  rowActions: (occurrenceId: string) => SessionRowAction[];
  footnote: ReactNode;
  dialog: ReactNode;
} {
  const { toast } = useToast();
  const viewer = useViewerZone();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const giveBack = useMutation({
    mutationFn: (occurrenceId: string) =>
      postReturn(appointmentId, occurrenceId),
    onSuccess: (data) => {
      toast({
        title: "Session returned to your plan",
        description: data.planEndsAt
          ? `Your plan now runs until ${formatForViewer(lastInstantBefore(new Date(data.planEndsAt)), viewer, "EEE d MMM")}. Your expert has been told, so a new time can be booked.`
          : "Your expert has been told, so a new time can be booked.",
      });
      onChanged();
    },
    onError: (error: Error) =>
      toast({
        title: "Not returned",
        description: error.message,
        variant: "destructive",
      }),
  });
  const dialog = (
    <SessionConfirmDialog pending={pending} onClose={() => setPending(null)} />
  );

  const now = new Date();
  const upcoming = new Map(
    (enabled ? sessions : [])
      .filter(
        (s) =>
          !s.deletedAt &&
          !s.isTentative &&
          (s.completionStatus ?? "SCHEDULED") === "SCHEDULED" &&
          toDate(s.startsAt).getTime() > now.getTime(),
      )
      .map((s) => [s.id, s]),
  );
  if (upcoming.size === 0) {
    return { rowActions: () => [], footnote: null, dialog };
  }

  const rowActions = (occurrenceId: string): SessionRowAction[] => {
    const s = upcoming.get(occurrenceId);
    if (!s) return [];
    const block = returnBlock({
      startsAt: s.startsAt,
      now,
      sessionsReturned,
      rescheduleOpen,
    });
    return [
      {
        key: "return-to-plan",
        label: "Return to plan",
        disabled: !!block || giveBack.isPending,
        blockedBecause: block ? RETURN_BLOCK_COPY[block] : undefined,
        onSelect: () =>
          setPending({
            title: "Return this session to your plan?",
            body: RETURN_CONFIRM_COPY,
            confirmLabel: "Return to plan",
            onConfirm: () => giveBack.mutate(s.id),
          }),
      },
    ];
  };

  return {
    rowActions,
    dialog,
    footnote: (
      <p className="text-xs text-muted-foreground">
        Can&apos;t make a session? Return it to your plan at least 24 hours
        ahead from its menu ({sessionsReturned} of {RETURN_CAP} returns used).
      </p>
    ),
  };
}
