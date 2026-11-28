"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import { useToast } from "@/hooks/use-toast";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import { NEGATIVE_MONEY_OUTCOMES } from "@/lib/booking/misses";

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
  outcome?: string | null;
  outcomeConfirmedAt?: NullableDate;
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

const NEEDS_CONFIRMATION: readonly string[] = NEGATIVE_MONEY_OUTCOMES;

/** The client twin of `makeUpWindowStart` (lib/booking/misses.ts): null while a void's verdict waits for its confirmation. */
const makeUpWindowStart = (s: ClassSessionRow): NullableDate => {
  if (s.hostCancelledAt) return s.hostCancelledAt;
  if (!s.voidedAt) return null;
  return s.outcome && NEEDS_CONFIRMATION.includes(s.outcome)
    ? (s.outcomeConfirmedAt ?? null)
    : s.voidedAt;
};

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
 * back (E-3b). Row actions go to the session list: the host schedules a
 * make-up from the cancelled session's row in a dialog.
 */
export function useClassSessionActions({
  appointmentId,
  classId,
  consultantProfileId,
  sessions,
  role,
  unitLabel,
  onChanged,
}: Readonly<{
  appointmentId: string;
  /** The class, so the make-up picker counts its co-hosts' time. */
  classId: string | null;
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
  const [makeUpAt, setMakeUpAt] = useState<
    Record<string, SingleTimeValue | null>
  >({});
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [makeUpFor, setMakeUpFor] = useState<string | null>(null);
  const base = `/api/appointments/${appointmentId}/occurrences`;
  const done = (title: string) => () => {
    toast({ title });
    onChanged();
  };
  const failed = (title: string) => (error: Error) =>
    toast({ title, description: error.message, variant: "destructive" });

  const cancel = useMutation({
    mutationFn: (id: string) => post(`${base}/${id}/cancel`),
    onSuccess: done("Session cancelled"),
    onError: failed("Couldn't cancel this session"),
  });
  const makeUp = useMutation({
    mutationFn: (args: { id: string; startsAt: string }) =>
      post(`${base}/${args.id}/make-up`, { startsAt: args.startsAt }),
    onSuccess: done("Make-up scheduled"),
    onError: failed("Couldn't book the make-up"),
  });
  const skip = useMutation({
    mutationFn: (id: string) => post(`${base}/${id}/skip-make-up`),
    onSuccess: done("Session refunded"),
    onError: failed("Couldn't refund this session"),
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
  const owed = new Map(
    open.filter((p) => !p.makeUp).map((p) => [p.source.id, p.source]),
  );
  const rowActions = (occurrenceId: string): SessionRowAction[] => {
    const actions: SessionRowAction[] = [];
    if (owed.has(occurrenceId)) {
      actions.push({
        key: "make-up",
        label: "Schedule make-up",
        disabled: makeUp.isPending,
        onSelect: () => setMakeUpFor(occurrenceId),
      });
    }
    if (cancellable.has(occurrenceId)) {
      actions.push({
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
      });
    }
    return actions;
  };

  const source = makeUpFor ? owed.get(makeUpFor) : undefined;
  const windowStart = source ? makeUpWindowStart(source) : null;
  // Before a void's confirmation the window has not started: 14 days from now, as the server counts it.
  const by = source
    ? new Date(
        (windowStart ? toDate(windowStart).getTime() : now) +
          MAKEUP_WINDOW_DAYS * DAY_MS,
      )
    : null;
  const picked = source ? (makeUpAt[source.id] ?? null) : null;
  const makeUpDialog = (
    <Dialog
      open={!!source}
      onOpenChange={(isOpen) => !isOpen && setMakeUpFor(null)}
    >
      {source && by && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule a make-up</DialogTitle>
            <DialogDescription>
              {source.voidedAt ? "Missed" : "Cancelled"} {when(source.startsAt)}{" "}
              — make up by {when(by)}.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {consultantProfileId && (
              <SingleTimePicker
                className="w-full"
                consultantId={consultantProfileId}
                zone={viewer.zone}
                theme="light"
                audience="host"
                sessionMinutes={sessionMinutesOf(source)}
                purpose="makeup"
                event={classId ? { classId } : undefined}
                allowedEnd={by}
                value={picked}
                onChange={(next) =>
                  setMakeUpAt((m) => ({ ...m, [source.id]: next }))
                }
              />
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMakeUpFor(null)}>
              Not now
            </Button>
            <Button
              disabled={!picked || makeUp.isPending}
              onClick={() => {
                if (!picked) return;
                makeUp.mutate(
                  { id: source.id, startsAt: picked.startsAt },
                  { onSuccess: () => setMakeUpFor(null) },
                );
              }}
            >
              Schedule make-up
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return {
    rowActions,
    notices: null,
    dialog: (
      <>
        {dialog}
        {makeUpDialog}
      </>
    ),
  };
}
