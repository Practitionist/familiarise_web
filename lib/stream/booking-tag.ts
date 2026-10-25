import { z } from "zod";

/** The custom message field naming the booking a DM message is about. */
export const BOOKING_TAG_FIELD = "booking_appointment_id";

export const bookingTagQuerySchema = z.object({
  appointmentId: z.string().min(1).max(64),
  cid: z.string().regex(/^messaging:[\w-]{1,64}$/),
});

/** What the server verified about a tagged booking; message fields never feed this. */
export const bookingTagSchema = z.object({
  title: z.string(),
  kind: z.string(),
  nextSessionAt: z.string().nullable(),
  lastSessionAt: z.string().nullable(),
});
export type BookingTag = z.infer<typeof bookingTagSchema>;

/** The earliest session not yet over, else the latest one; tentative and dead rows are filtered by the caller. */
export function pickSessionAnchor(
  occurrences: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
  now: Date,
): Pick<BookingTag, "nextSessionAt" | "lastSessionAt"> {
  let next: Date | null = null;
  let last: Date | null = null;
  for (const o of occurrences) {
    if (o.endsAt > now) {
      if (!next || o.startsAt < next) next = o.startsAt;
    } else if (!last || o.startsAt > last) {
      last = o.startsAt;
    }
  }
  if (next) return { nextSessionAt: next.toISOString(), lastSessionAt: null };
  return { nextSessionAt: null, lastSessionAt: last?.toISOString() ?? null };
}

const SESSION_PATTERN = "EEE, d MMM, h:mm a";

export function bookingTagLabel(
  tag: BookingTag,
  format: (date: string, pattern: string) => string,
): string {
  const parts = [`About: ${tag.title}`];
  if (tag.nextSessionAt) {
    parts.push(`next session ${format(tag.nextSessionAt, SESSION_PATTERN)}`);
  } else if (tag.lastSessionAt) {
    parts.push(`last session ${format(tag.lastSessionAt, SESSION_PATTERN)}`);
  }
  return parts.join(" · ");
}

export function bookingTagUrl(appointmentId: string, cid: string): string {
  const params = new URLSearchParams({ appointmentId, cid });
  return `/api/stream/booking-tag?${params.toString()}`;
}

/** Stamps the booking on both the optimistic and the sent copy, so a retried send keeps it. */
export function withBookingTag<
  T extends { localMessage: object; message: object },
>(params: T, appointmentId: string): T {
  const tag = { [BOOKING_TAG_FIELD]: appointmentId };
  return {
    ...params,
    localMessage: { ...params.localMessage, ...tag },
    message: { ...params.message, ...tag },
  };
}
