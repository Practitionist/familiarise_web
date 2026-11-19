"use client";

import Link from "next/link";
import { useRef } from "react";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { formatDateTimeLabel } from "@/lib/time/display";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import type { AvailabilitySavePreview } from "@/schemas/availability-preview";

type Session = AvailabilitySavePreview["sessions"][number];

/** Where a booking outside the new hours is moved or cancelled from. */
export function outsideHoursLinks(consultantId: string, appointmentId: string) {
  const base = `/dashboard/consultant/${consultantId}/appointments/${appointmentId}`;
  return { reschedule: `${base}/reschedule`, cancel: base };
}

function SessionList({
  consultantId,
  sessions,
  withLinks,
}: Readonly<{
  consultantId: string;
  sessions: Session[];
  withLinks: boolean;
}>) {
  const { zone } = useViewerZone();
  return (
    <ul className="max-h-48 space-y-2 overflow-y-auto">
      {sessions.map((session) => {
        const links = outsideHoursLinks(consultantId, session.appointmentId);
        return (
          <li
            key={session.appointmentId}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              {[
                formatDateTimeLabel(new Date(session.startsAt), { zone }),
                session.learnerName,
                session.planTitle ?? "A booking",
              ]
                .filter(Boolean)
                .join(" · ")}
              {session.held ? " · awaiting payment or approval" : ""}
            </span>
            {withLinks && (
              <span className="flex gap-3">
                <Link className="underline" href={links.reschedule}>
                  Reschedule
                </Link>
                <Link className="underline" href={links.cancel}>
                  Cancel booking
                </Link>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Asked before an availability save that leaves upcoming bookings outside the
 * new hours, or removes custom dates. Bookings keep their times; the links to
 * move or cancel them appear only once the hours are saved.
 */
export function AvailabilitySaveConfirm({
  consultantId,
  preview,
  saved,
  onConfirm,
  onClose,
}: Readonly<{
  consultantId: string;
  preview: AvailabilitySavePreview | null;
  /** The held save went through; the dialog now offers the bookings' links. */
  saved: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}>) {
  // The confirm dialog closes itself once its save resolves; that close is the
  // hand-over to the saved state, not a cancel.
  const handedOver = useRef(false);
  const sessions = preview?.sessions ?? [];
  const removed = preview?.customDatesRemoved ?? 0;
  const count = sessions.length;
  return (
    <>
      <ConfirmDialog
        open={preview !== null && !saved}
        onOpenChange={(open) => {
          if (open) return;
          if (handedOver.current) {
            handedOver.current = false;
            return;
          }
          onClose();
        }}
        title="Save these hours?"
        confirmLabel="Save anyway"
        cancelLabel="Keep editing"
        onConfirm={async () => {
          await onConfirm();
          handedOver.current = true;
        }}
      >
        <div className="space-y-3 text-sm">
          {count > 0 && (
            <>
              <p>
                {count === 1
                  ? "This booking would fall outside your new hours. It keeps its time."
                  : `These ${count} bookings would fall outside your new hours. They keep their times.`}
              </p>
              <SessionList
                consultantId={consultantId}
                sessions={sessions}
                withLinks={false}
              />
            </>
          )}
          {removed > 0 && (
            <p>
              {`Saving weekly hours removes your ${removed} upcoming custom ${removed === 1 ? "date" : "dates"}.`}
            </p>
          )}
        </div>
      </ConfirmDialog>
      <ResponsiveModal
        open={preview !== null && saved && count > 0}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <ResponsiveModalContent className="sm:max-w-md">
          <div className="space-y-4">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Hours saved</ResponsiveModalTitle>
            </ResponsiveModalHeader>
            <div className="space-y-3 text-sm">
              <p>
                {count === 1
                  ? "1 booking is outside your new hours. Reschedule or cancel it if you can't make it."
                  : `${count} bookings are outside your new hours. Reschedule or cancel any you can't make.`}
              </p>
              <SessionList
                consultantId={consultantId}
                sessions={sessions}
                withLinks
              />
            </div>
            <ResponsiveModalFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </ResponsiveModalFooter>
          </div>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
