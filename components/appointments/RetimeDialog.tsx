"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import { useSession } from "@/lib/auth-client";
import { RESCHEDULE_MIN_LEAD_HOURS } from "@/lib/booking/lead-time";
import {
  canSwitchToDeviceZone,
  dayRows,
  resolveGridZone,
} from "@/lib/time/grid-zone";

interface RetimeDialogProps {
  isOpen: boolean;
  /** Resolves once the move landed or was refused; the dialog closes on true. */
  onConfirm: (startsAt: string) => Promise<boolean>;
  onCancel: () => void;
  title: string;
  isLoading?: boolean;
}

/** The starts the server accepts on `dayKey` (yyyy-MM-dd) in `zone`: grid atoms at least the lead time away. */
export function retimeStartsOn(
  dayKey: string,
  zone: string,
  now: Date = new Date(),
): Array<{ iso: string; label: string }> {
  const [year, month, date] = dayKey.split("-").map(Number);
  if (!year || !month || !date) return [];
  const earliest = now.getTime() + RESCHEDULE_MIN_LEAD_HOURS * 3_600_000;
  return dayRows(new Date(year, month - 1, date, 12), zone)
    .filter((row) => row.start.getTime() >= earliest)
    .map((row) => ({ iso: row.start.toISOString(), label: row.label }));
}

/**
 * Re-time moves a published webinar to a new date in one step: attendees are
 * told, keep their seats, and may leave with a full refund for a while. It is
 * not Cancel, which ends the webinar and refunds everyone now.
 */
export function RetimeDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  isLoading = false,
}: Readonly<RetimeDialogProps>) {
  const { data: session } = useSession();
  const profileZone = session?.user?.timezone ?? null;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [useDeviceZone, setUseDeviceZone] = useState(false);
  const zone = resolveGridZone(profileZone, deviceZone, useDeviceZone);
  const [day, setDay] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const starts = useMemo(
    () => (day ? retimeStartsOn(day, zone) : []),
    [day, zone],
  );
  const picked = starts.some((s) => s.iso === startsAt) ? startsAt : "";

  const reset = () => {
    setDay("");
    setStartsAt("");
  };
  const close = () => {
    reset();
    onCancel();
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-amber-500" />
            Move this webinar to a new date
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Pick the new start for <strong>&quot;{title}&quot;</strong>. It
                keeps its length.
              </p>
              <p className="text-muted-foreground">
                Everyone enrolled is told and keeps their seat. Anyone who
                can&apos;t make the new time can leave with a full refund.
              </p>
              <p className="text-muted-foreground text-sm">
                To end the webinar and refund everyone now, use{" "}
                <strong>Cancel booking</strong>.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="retime-day">New date</Label>
            <Input
              id="retime-day"
              type="date"
              value={day}
              onChange={(event) => {
                setDay(event.target.value);
                setStartsAt("");
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="retime-start">New start</Label>
            <select
              id="retime-start"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={picked}
              disabled={starts.length === 0}
              onChange={(event) => setStartsAt(event.target.value)}
            >
              <option value="">
                {day && starts.length === 0
                  ? `No start on this date is ${RESCHEDULE_MIN_LEAD_HOURS} hours away`
                  : "Pick a time"}
              </option>
              {starts.map((s) => (
                <option key={s.iso} value={s.iso}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <ZoneSwitch
            zone={zone}
            usingDeviceZone={useDeviceZone}
            canSwitch={canSwitchToDeviceZone(profileZone, deviceZone)}
            onToggle={() => setUseDeviceZone((v) => !v)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close} disabled={isLoading}>
            Keep the date
          </AlertDialogCancel>
          <Button
            onClick={() => {
              if (!picked) return;
              void onConfirm(picked).then((moved) => {
                if (moved) reset();
              });
            }}
            disabled={isLoading || !picked}
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Moving...
              </>
            ) : (
              "Move webinar"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
