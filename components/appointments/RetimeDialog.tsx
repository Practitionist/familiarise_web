"use client";

import { useState } from "react";
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
import { SingleSessionPicker } from "@/components/scheduling/SingleSessionPicker";
import { useViewerZone } from "@/lib/time/use-viewer-zone";

interface RetimeDialogProps {
  isOpen: boolean;
  /** Resolves once the move landed or was refused; the dialog closes on true. */
  onConfirm: (startsAt: string) => Promise<boolean>;
  onCancel: () => void;
  title: string;
  /** The host whose calendar labels the new times. */
  consultantId: string;
  /** The session keeps its length; the picker checks that much free time. */
  sessionMinutes: number;
  /** The webinar being moved: its own session reads free, its co-hosts' time busy. */
  webinarId?: string;
  isLoading?: boolean;
}

/**
 * Re-time moves a published webinar to a new date in one step: attendees are
 * told, keep their seats, and may leave with a full refund for a while. It is
 * not Cancel, which ends the webinar and refunds everyone now. The new start is
 * picked on the host's own calendar, at least 24 hours out and on the half hour.
 */
export function RetimeDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  consultantId,
  sessionMinutes,
  webinarId,
  isLoading = false,
}: Readonly<RetimeDialogProps>) {
  const { zone } = useViewerZone();
  const [picked, setPicked] = useState<string | null>(null);

  const close = () => {
    setPicked(null);
    onCancel();
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent className="max-w-2xl grid-cols-[minmax(0,1fr)]">
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
        <SingleSessionPicker
          consultantId={consultantId}
          zone={zone}
          sessionMinutes={sessionMinutes}
          purpose="retime"
          event={webinarId ? { webinarId, moving: true } : undefined}
          value={picked}
          onChange={setPicked}
        />
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close} disabled={isLoading}>
            Keep the date
          </AlertDialogCancel>
          <Button
            onClick={() => {
              if (!picked) return;
              void onConfirm(picked).then((moved) => {
                if (moved) setPicked(null);
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
