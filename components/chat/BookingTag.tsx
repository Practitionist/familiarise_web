"use client";

import { useCallback, useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { CalendarIcon, XIcon } from "lucide-react";
import {
  MessageComposer,
  useChannelActionContext,
  useChannelStateContext,
} from "stream-chat-react";
import type { ComponentProps } from "react";
import { useZonedFormat } from "@/lib/time/zoned-format";
import {
  bookingTagLabel,
  bookingTagSchema,
  bookingTagUrl,
  withBookingTag,
  type BookingTag,
} from "@/lib/stream/booking-tag";
import { cn } from "@/utils/tailwind";
import { Skeleton } from "@/components/ui/skeleton";

const CHIP_ROW =
  "flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-2 text-xs";
const CHIP =
  "inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-2xl border border-border bg-background px-2.5 py-1";

type SubmitParams = Parameters<
  NonNullable<ComponentProps<typeof MessageComposer>["overrideSubmitHandler"]>
>[0];

/** The server-verified booking for (appointment, DM); null when the server refuses it. */
export function bookingTagQueryOptions(
  appointmentId: string | null,
  cid: string | null,
) {
  return queryOptions({
    queryKey: ["booking-tag", appointmentId, cid] as const,
    enabled: Boolean(appointmentId && cid),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<BookingTag | null> => {
      if (!appointmentId || !cid) return null;
      const res = await fetch(bookingTagUrl(appointmentId, cid));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Booking tag lookup failed (${res.status})`);
      return bookingTagSchema.parse(await res.json());
    },
  });
}

export function useBookingTag(
  appointmentId: string | null,
  cid: string | null,
) {
  return useQuery(bookingTagQueryOptions(appointmentId, cid));
}

/** The tag on a sent message, rendered only from the server's answer; the session time is in its tooltip. */
export function MessageBookingTag({
  appointmentId,
  cid,
  mine,
}: Readonly<{ appointmentId: string; cid: string; mine: boolean }>) {
  const format = useZonedFormat();
  const { data: tag } = useBookingTag(appointmentId, cid);
  if (!tag) return null;
  return (
    <div
      data-testid="booking-tag"
      title={bookingTagLabel(tag, format)}
      className={cn(
        "mb-1 flex max-w-64 items-center gap-1.5 text-[11px]",
        mine ? "text-primary-foreground/80" : "text-muted-foreground",
      )}
    >
      <CalendarIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{tag.title}</span>
    </div>
  );
}

/**
 * The composer, with a removable booking chip when a DM was opened from an
 * appointment. The chip tags only the next message sent, then goes away.
 */
export function BookingTagComposer({
  contextAppointmentId,
}: Readonly<{ contextAppointmentId: string | null }>) {
  const format = useZonedFormat();
  const { channel } = useChannelStateContext();
  const { sendMessage } = useChannelActionContext();
  const cid = channel.type === "messaging" ? channel.cid : null;
  const tagKey =
    contextAppointmentId && cid ? `${cid}:${contextAppointmentId}` : null;
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const { data: tag, isLoading } = useBookingTag(contextAppointmentId, cid);
  const active = Boolean(tag && tagKey && doneKey !== tagKey);
  // Holds the chip's row while the lookup runs, so the list does not jump when it lands.
  const reserving = Boolean(isLoading && tagKey && doneKey !== tagKey);

  const submit = useCallback(
    async (params: SubmitParams) => {
      const tagged =
        active && contextAppointmentId
          ? withBookingTag(params, contextAppointmentId)
          : params;
      if (active) setDoneKey(tagKey);
      await sendMessage({
        localMessage: tagged.localMessage,
        message: tagged.message,
        options: tagged.sendOptions,
      });
    },
    [active, contextAppointmentId, sendMessage, tagKey],
  );

  return (
    <>
      {reserving && (
        <div
          data-testid="booking-tag-reserve"
          aria-hidden="true"
          className={CHIP_ROW}
        >
          <span className={CHIP}>
            <Skeleton className="h-4 w-48" />
          </span>
        </div>
      )}
      {active && tag && (
        <div className={CHIP_ROW}>
          <span data-testid="booking-tag-chip" className={CHIP}>
            <CalendarIcon
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">
              {bookingTagLabel(tag, format)}
            </span>
            <button
              type="button"
              onClick={() => setDoneKey(tagKey)}
              aria-label="Remove booking tag"
              className="-mr-1 shrink-0 rounded-full p-0.5 hover:bg-muted"
            >
              <XIcon className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        </div>
      )}
      <MessageComposer focus overrideSubmitHandler={submit} />
    </>
  );
}
