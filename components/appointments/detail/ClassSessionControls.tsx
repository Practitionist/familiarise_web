"use client";

import { useMutation } from "@tanstack/react-query";
import { fromZonedTime } from "date-fns-tz";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";

type NullableDate = Date | string | null;

/** One class session as the detail read carries it (#1780 row 4). */
export interface ClassSessionRow {
  id: string;
  ordinal: number;
  startsAt: Date | string;
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

const missedAt = (s: ClassSessionRow) => s.hostCancelledAt ?? s.voidedAt;

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

/** A button that asks before it acts. */
function ConfirmButton({
  label,
  title,
  body,
  disabled,
  onConfirm,
  variant = "outline",
}: Readonly<{
  label: string;
  title: string;
  body: string;
  disabled: boolean;
  onConfirm: () => void;
  variant?: "outline" | "ghost";
}>) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={variant} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * #1780 row 4 — the per-session controls of a class. The host cancels one
 * future session and schedules its make-up within 14 days (E-6); a seat
 * holder who cannot make a make-up takes that session back (E-3b).
 */
export function ClassSessionControls({
  appointmentId,
  sessions,
  role,
  unitLabel,
  onChanged,
}: Readonly<{
  appointmentId: string;
  sessions: ClassSessionRow[];
  role: "consultant" | "consultee";
  /** The seat's per-session amount, e.g. "₹1,000"; null when unknown. */
  unitLabel: string | null;
  onChanged: () => void;
}>) {
  const { toast } = useToast();
  const viewer = useViewerZone();
  const [makeUpAt, setMakeUpAt] = useState<Record<string, string>>({});
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
      post(`${base}/${args.id}/make-up`, {
        // The picker's wall-clock time is in the viewer's profile zone.
        startsAt: fromZonedTime(args.startsAt, viewer.zone).toISOString(),
      }),
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

  if (role === "consultee") {
    // Skippable only while the make-up is still ahead (the server's rule).
    const skippable = open.filter(
      (p) => p.makeUp && toDate(p.makeUp.startsAt).getTime() > now,
    );
    if (skippable.length === 0) return null;
    return (
      <div className="space-y-2">
        {skippable.map(({ source, makeUp: row }) => (
          <div
            key={source.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
          >
            <span>
              Make-up for the {when(source.startsAt)} session is on{" "}
              {row && when(row.startsAt)}.
            </span>
            <ConfirmButton
              label="Can't make it — refund this session"
              title="Refund this session?"
              body={`This session${skipUnit} comes back to you instead of the make-up. You keep your seat for the rest of the series.`}
              disabled={skip.isPending}
              onConfirm={() => skip.mutate(source.id)}
            />
          </div>
        ))}
      </div>
    );
  }

  const upcoming = sessions.filter(
    (s) =>
      !s.deletedAt &&
      s.completionStatus === "SCHEDULED" &&
      toDate(s.startsAt).getTime() > now,
  );
  return (
    <div className="space-y-2">
      {upcoming.map((s) => (
        <div
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span>{when(s.startsAt)}</span>
          <ConfirmButton
            label="Cancel this session"
            title="Cancel this session?"
            body={`Learners are told; you have ${MAKEUP_WINDOW_DAYS} days to schedule a make-up or each seat is refunded${refundUnit}.`}
            disabled={cancel.isPending}
            onConfirm={() => cancel.mutate(s.id)}
            variant="ghost"
          />
        </div>
      ))}
      {open
        .filter((p) => !p.makeUp)
        .map(({ source }) => {
          const by = new Date(
            toDate(missedAt(source)!).getTime() + MAKEUP_WINDOW_DAYS * DAY_MS,
          );
          return (
            <div
              key={source.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm"
            >
              <span className="flex-1">
                {source.voidedAt ? "Missed" : "Cancelled"}{" "}
                {when(source.startsAt)} — make up by {when(by)}.
              </span>
              <input
                type="datetime-local"
                aria-label="Make-up start"
                className="rounded-md border border-border bg-background px-2 py-1"
                value={makeUpAt[source.id] ?? ""}
                onChange={(e) =>
                  setMakeUpAt((m) => ({ ...m, [source.id]: e.target.value }))
                }
              />
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
}
