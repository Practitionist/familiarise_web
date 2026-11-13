"use client";

import Link from "next/link";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { formatDateTimeLabel } from "@/lib/time/display";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import type { AvailabilitySavePreview } from "./use-consultant-settings-form";

/**
 * Asked before an availability save that leaves upcoming bookings outside the
 * new hours, or removes custom dates. The bookings keep their times either way.
 */
export function AvailabilitySaveConfirm({
  consultantId,
  preview,
  onConfirm,
  onCancel,
}: Readonly<{
  consultantId: string;
  preview: AvailabilitySavePreview | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}>) {
  const { zone } = useViewerZone();
  const sessions = preview?.sessions ?? [];
  const removed = preview?.customDatesRemoved ?? 0;
  const base = `/dashboard/consultant/${consultantId}/appointments`;
  return (
    <ConfirmDialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Save these hours?"
      confirmLabel="Save anyway"
      onConfirm={onConfirm}
    >
      <div className="space-y-3 text-sm">
        {sessions.length > 0 && (
          <>
            <p>
              {sessions.length === 1
                ? "This booking would fall outside your new hours. It keeps its time; reschedule or cancel it if you can't make it."
                : `These ${sessions.length} bookings would fall outside your new hours. They keep their times; reschedule or cancel any you can't make.`}
            </p>
            <ul className="max-h-48 space-y-2 overflow-y-auto">
              {sessions.map((session) => (
                <li
                  key={session.appointmentId}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {formatDateTimeLabel(new Date(session.startsAt), { zone })}
                    {session.held ? " · awaiting payment or approval" : ""}
                  </span>
                  <span className="flex gap-3">
                    <Link
                      className="underline"
                      href={`${base}/${session.appointmentId}/reschedule`}
                    >
                      Reschedule
                    </Link>
                    <Link
                      className="underline"
                      href={`${base}/${session.appointmentId}`}
                    >
                      Cancel
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {removed > 0 && (
          <p>
            {`Saving weekly hours removes your ${removed} upcoming custom ${removed === 1 ? "date" : "dates"}.`}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
