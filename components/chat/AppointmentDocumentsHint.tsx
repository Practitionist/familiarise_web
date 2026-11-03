"use client";

import { FileTextIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { LocalMessage } from "stream-chat";
import { useChannelStateContext } from "stream-chat-react";
import { goHref } from "@/lib/dashboard/go";

// Message fields are user-writable, so the receipt id is checked at runtime.
function bookingAppointmentIdOf(message: LocalMessage): string | null {
  const direct: unknown = message.booking_appointment_id;
  if (typeof direct === "string") return direct;
  const nested: unknown = message.custom?.booking_appointment_id;
  return typeof nested === "string" ? nested : null;
}

/**
 * Points the appointment's conversation at its documents tab; shown only when
 * the URL names the appointment and a loaded message carries its booking receipt.
 */
export const AppointmentDocumentsHint = () => {
  const searchParams = useSearchParams();
  const appointmentId =
    searchParams?.get("contextAppointmentId")?.trim() ||
    searchParams?.get("appointmentId")?.trim() ||
    null;
  const { channel, messages } = useChannelStateContext();
  if (!appointmentId) return null;

  const loadedMessages = messages ?? channel.state.messages ?? [];
  const hasReceipt = loadedMessages.some(
    (message) => bookingAppointmentIdOf(message) === appointmentId,
  );
  if (!hasReceipt) return null;

  return (
    <output
      data-testid="appointment-documents-hint"
      className="flex items-center justify-center gap-2 border-t border-info/40 bg-info/10 px-4 py-2 text-sm text-foreground"
    >
      <FileTextIcon className="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <span>
        Share files under{" "}
        <Link
          href={goHref(
            "auto",
            `appointments/${encodeURIComponent(appointmentId)}/documents`,
          )}
          prefetch={false}
          className="font-medium text-primary underline underline-offset-4 hover:no-underline"
        >
          Documents
        </Link>{" "}
        for this session
      </span>
    </output>
  );
};
