"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
  EVENT_WAITLIST_QUERY_KEY,
} from "@/lib/booking/interest/query-keys";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";
import {
  BackupInterestListResponseSchema,
  EventWaitlistListResponseSchema,
  type BackupInterestEntry,
  type EventWaitlistAlert,
} from "@/schemas/interest";

const SESSION_FORMAT = "EEE, d MMM · h:mm a";

async function fetchEventWaitlist(): Promise<EventWaitlistAlert[]> {
  const res = await fetch("/api/scheduling/event-waitlist");
  if (!res.ok) return [];
  const parsed = EventWaitlistListResponseSchema.safeParse(
    await res.json().catch(() => null),
  );
  return parsed.success ? parsed.data.data : [];
}

async function fetchBackupInterest(): Promise<BackupInterestEntry[]> {
  const res = await fetch("/api/scheduling/backup-interest");
  if (!res.ok) return [];
  const parsed = BackupInterestListResponseSchema.safeParse(
    await res.json().catch(() => null),
  );
  return parsed.success ? parsed.data.data : [];
}

async function failureMessage(res: Response, fallback: string) {
  const body: unknown = await res.json().catch(() => null);
  const message =
    body && typeof body === "object" && "error" in body
      ? body.error
      : undefined;
  return typeof message === "string" ? message : fallback;
}

function windowText(entry: BackupInterestEntry, zone: ViewerZone): string {
  const start = new Date(entry.windowStart);
  const end = new Date(entry.windowEnd);
  if (Number.isNaN(start.getTime())) return "";
  const startLabel = formatForViewer(start, zone, SESSION_FORMAT);
  return Number.isNaN(end.getTime())
    ? startLabel
    : `${startLabel} – ${formatForViewer(end, zone, "h:mm a")}`;
}

/** Checkout rejects a start in the past, so a window already under way cannot be booked. */
function hasStarted(entry: BackupInterestEntry, nowMs: number): boolean {
  return new Date(entry.windowStart).getTime() <= nowMs;
}

function backupStatusText(entry: BackupInterestEntry, nowMs: number): string {
  if (hasStarted(entry, nowMs)) return " · This time has started";
  return entry.status === "NOTIFIED"
    ? " · This time opened"
    : " · Waiting for this time to open";
}

function backupBookHref(entry: BackupInterestEntry): string {
  if (entry.planId && entry.planKind === "CONSULTATION") {
    const qs = new URLSearchParams({
      startsAt: entry.windowStart,
      endsAt: entry.windowEnd,
    });
    return `/checkout/plans/consultation/${entry.planId}?${qs.toString()}`;
  }
  return `/explore/experts/${entry.consultantProfileId}`;
}

/**
 * The learner's open notify-only alerts: seats on sold-out webinars and
 * classes, and 1:1 windows they asked to hear about. Hidden when there are none.
 */
export function MyAlerts({ viewerZone }: Readonly<{ viewerZone: ViewerZone }>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const waitlist = useQuery({
    queryKey: EVENT_WAITLIST_QUERY_KEY,
    staleTime: 60_000,
    queryFn: fetchEventWaitlist,
  });
  const backup = useQuery({
    queryKey: CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
    staleTime: 60_000,
    queryFn: fetchBackupInterest,
  });

  const leaveWaitlist = useMutation({
    mutationFn: async (alert: EventWaitlistAlert) => {
      const res = await fetch("/api/scheduling/event-waitlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: alert.kind, eventId: alert.eventId }),
      });
      if (!res.ok)
        throw new Error(await failureMessage(res, "Could not leave"));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: EVENT_WAITLIST_QUERY_KEY,
      });
      toast({ title: "You left the waitlist" });
    },
    onError: (err: Error) =>
      toast({
        title: "Couldn't leave the waitlist",
        description: err.message,
        variant: "destructive",
      }),
  });

  const stopBackup = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/scheduling/backup-interest?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error(
          await failureMessage(res, "Could not update notification preference"),
        );
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: CONSULTEE_BACKUP_INTEREST_QUERY_KEY,
      });
      toast({
        title: "Notification removed",
        description: "You won't be notified about this time.",
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Couldn't update notification",
        description: err.message,
        variant: "destructive",
      }),
  });

  const nowMs = Date.now();
  const waitlistRows = waitlist.data ?? [];
  const backupRows = (backup.data ?? []).filter(
    (entry) => new Date(entry.windowEnd).getTime() > nowMs,
  );
  if (waitlistRows.length === 0 && backupRows.length === 0) return null;

  return (
    <section
      aria-label="My alerts"
      data-testid="my-alerts"
      className="rounded-xl border border-border bg-card px-4 py-3"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <BellRing className="h-4 w-4" aria-hidden />
        My alerts
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Nothing is held for you. First to book gets the seat or the time.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {waitlistRows.map((alert) => {
          const seatOpen = alert.status === "NOTIFIED" && alert.seatAvailable;
          return (
            <li
              key={`${alert.kind}:${alert.eventId}`}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {alert.planTitle}
                </p>
                <p className="text-xs text-muted-foreground">
                  {alert.nextSessionAt
                    ? `Next session ${formatForViewer(new Date(alert.nextSessionAt), viewerZone, SESSION_FORMAT)}`
                    : "No session scheduled"}
                  {seatOpen ? "" : " · Waiting for a seat"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {seatOpen && (
                  <Button size="sm" asChild>
                    <Link href={alert.checkoutHref}>Seat open — book now</Link>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={leaveWaitlist.isPending}
                  onClick={() => leaveWaitlist.mutate(alert)}
                >
                  Leave
                </Button>
              </div>
            </li>
          );
        })}
        {backupRows.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {entry.consultantProfile?.user.name ?? "Your expert"}
              </p>
              <p className="text-xs text-muted-foreground">
                {windowText(entry, viewerZone)}
                {backupStatusText(entry, nowMs)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {entry.status === "NOTIFIED" && !hasStarted(entry, nowMs) && (
                <Button size="sm" asChild>
                  <Link href={backupBookHref(entry)}>Book now</Link>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={stopBackup.isPending}
                onClick={() => stopBackup.mutate(entry.id)}
              >
                Stop notifying me
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
