"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SingleSessionPicker } from "@/components/scheduling/SingleSessionPicker";
import { useToast } from "@/hooks/use-toast";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";
import { fetchWithIdentity } from "@/lib/auth/identity-header";

import {
  SessionConfirmDialog,
  type PendingConfirm,
} from "./SessionConfirmDialog";
import type { SessionRowAction } from "./SessionSchedule";

type NullableDate = Date | string | null;

/** One class session as the detail read carries it (#1780 row 4). */
export interface ClassSessionRow {
  id: string;
  ordinal: number;
  startsAt: Date | string;
  endsAt?: Date | string;
  completionStatus: string | null;
  hostCancelledAt?: NullableDate;
  /** #1569 — a held session that lost too much time; owed a make-up like a cancel. */
  voidedAt?: NullableDate;
  seatsSettledAt?: NullableDate;
  deletedAt?: NullableDate;
}

const MAKEUP_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

async function post(url: string, body?: unknown) {
  const res = await fetchWithIdentity(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

const missedAt = (s: ClassSessionRow) => s.hostCancelledAt ?? s.voidedAt;

/** A make-up keeps its source's length; 60 minutes when the read lacks an end. */
function sessionMinutesOf(s: ClassSessionRow): number {
  if (!s.endsAt) return 60;
  const span = toDate(s.endsAt).getTime() - toDate(s.startsAt).getTime();
  return span > 0 ? Math.round(span / 60_000) : 60;
}

/**
 * The missed source of each ordinal (host-cancelled or voided), and its live
 * make-up if one exists — started or held too, so the host is not offered a
 * second one.
 */
function pairs(sessions: ClassSessionRow[]) {
  return sessions
    .filter((s) => missedAt(s) && !s.seatsSettledAt)
    .map((source) => ({
      source,
      makeUp: sessions.find(
        (s) =>
          s.ordinal === source.ordinal &&
          s.id !== source.id &&
          !s.deletedAt &&
          s.completionStatus !== "CANCELLED" &&
          s.completionStatus !== "RESCHEDULED" &&
          s.completionStatus !== "VOIDED",
      ),
    }));
}

/**
 * #1780 row 4 — the per-session controls of a class. The host cancels one
 * future session from that session's row and schedules its make-up within
 * 14 days (E-6); a seat holder who cannot make a make-up takes that session
 * back (E-3b). Row actions go to the session list; the make-up work, which
 * needs a time or a decision, renders as notices above it.
 */
export function useClassSessionActions({
  appointmentId,
  consultantProfileId,
  sessions,
  role,
  unitLabel,
  onChanged,
}: Readonly<{
  appointmentId: string;
  /** The host whose calendar labels make-up times. */
  consultantProfileId: string | null;
  sessions: ClassSessionRow[];
  role: "consultant" | "consultee";
  /** The seat's per-session amount, e.g. "₹1,000"; null when unknown. */
  unitLabel: string | null;
  onChanged: () => void;
}>): {
  rowActions: (occurrenceId: string) => SessionRowAction[];
  notices: ReactNode;
  dialog: ReactNode;
} {
  const { toast } = useToast();
  const viewer = useViewerZone();
  const [makeUpAt, setMakeUpAt] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const base = `/api/appointments/${appointmentId}/occurrences`;
  const done = (title: string) => () => {
    toast({ title });
    onChanged();
  };
  const failed = (error: Error) =>
    toast({
      title: "Not done",
      description: error.message,
      variant: "destructive",
    });

  const cancel = useMutation({
    mutationFn: (id: string) => post(`${base}/${id}/cancel`),
    onSuccess: done("Session cancelled"),
    onError: failed,
  });
  const makeUp = useMutation({
    mutationFn: (args: { id: string; startsAt: string }) =>
      post(`${base}/${args.id}/make-up`, { startsAt: args.startsAt }),
    onSuccess: done("Make-up scheduled"),
    onError: failed,
  });
  const skip = useMutation({
    mutationFn: (id: string) => post(`${base}/${id}/skip-make-up`),
    onSuccess: done("Session refunded"),
    onError: failed,
  });

  const now = Date.now();
  const open = pairs(sessions);
  const when = (d: Date | string) =>
    formatForViewer(toDate(d), viewer, "EEE d MMM, h:mm a");
  const skipUnit = unitLabel ? ` (${unitLabel})` : "";
  const refundUnit = unitLabel ? ` ${unitLabel}` : " one session";
  const dialog = (
    <SessionConfirmDialog pending={pending} onClose={() => setPending(null)} />
  );

  if (role === "consultee") {
    // Skippable only while the make-up is still ahead (the server's rule).
    const skippable = open.filter(
      (p) => p.makeUp && toDate(p.makeUp.startsAt).getTime() > now,
    );
    return {
      rowActions: () => [],
      dialog,
      notices:
        skippable.length === 0 ? null : (
          <div className="space-y-2">
            {skippable.map(({ source, makeUp: row }) => (
              <div
                key={source.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm"
              >
                <span>
                  Make-up for the {when(source.startsAt)} session is on{" "}
                  {row && when(row.startsAt)}.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={skip.isPending}
                  onClick={() =>
                    setPending({
                      title: "Refund this session?",
                      body: `This session${skipUnit} comes back to you instead of the make-up. You keep your seat for the rest of the series.`,
                      confirmLabel: "Can't make it — refund this session",
                      onConfirm: () => skip.mutate(source.id),
                    })
                  }
                >
                  Can&apos;t make it — refund this session
                </Button>
              </div>
            ))}
          </div>
        ),
    };
  }

  const cancellable = new Set(
    sessions
      .filter(
        (s) =>
          !s.deletedAt &&
          s.completionStatus === "SCHEDULED" &&
          toDate(s.startsAt).getTime() > now,
      )
      .map((s) => s.id),
  );
  const rowActions = (occurrenceId: string): SessionRowAction[] =>
    cancellable.has(occurrenceId)
      ? [
          {
            key: "cancel-session",
            label: "Cancel this session",
            destructive: true,
            disabled: cancel.isPending,
            onSelect: () =>
              setPending({
                title: "Cancel this session?",
                body: `Learners are told; you have ${MAKEUP_WINDOW_DAYS} days to schedule a make-up or each seat is refunded${refundUnit}.`,
                confirmLabel: "Cancel this session",
                onConfirm: () => cancel.mutate(occurrenceId),
              }),
          },
        ]
      : [];

  const owed = open.filter((p) => !p.makeUp);
  const notices =
    owed.length === 0 ? null : (
      <div className="space-y-2">
        {owed.map(({ source }) => {
          const by = new Date(
            toDate(missedAt(source)!).getTime() + MAKEUP_WINDOW_DAYS * DAY_MS,
          );
          return (
            <div
              key={source.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/20"
            >
              <span className="flex-1">
                {source.voidedAt ? "Missed" : "Cancelled"}{" "}
                {when(source.startsAt)} — make up by {when(by)}.
              </span>
              {consultantProfileId && (
                <SingleSessionPicker
                  className="w-full"
                  consultantId={consultantProfileId}
                  zone={viewer.zone}
                  sessionMinutes={sessionMinutesOf(source)}
                  purpose="makeup"
                  allowedEnd={by}
                  value={makeUpAt[source.id] ?? null}
                  onChange={(iso) =>
                    setMakeUpAt((m) => ({ ...m, [source.id]: iso ?? "" }))
                  }
                />
              )}
              <Button
                size="sm"
                disabled={!makeUpAt[source.id] || makeUp.isPending}
                onClick={() =>
                  makeUp.mutate({
                    id: source.id,
                    startsAt: makeUpAt[source.id],
                  })
                }
              >
                Schedule make-up
              </Button>
            </div>
          );
        })}
      </div>
    );
  return { rowActions, notices, dialog };
}
