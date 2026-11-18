import type { BookingHistoryEntity } from "@prisma/client";

/**
 * Booking-level history entities: a request, an event, a trial, a reschedule
 * or a session. Reads that judge a booking by its status history use only these,
 * so one attendee's seat moving never reads as the booking ending.
 */
export const BOOKING_HISTORY_ENTITIES = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
  "RESCHEDULE_REQUEST",
  "OCCURRENCE",
] as const satisfies readonly BookingHistoryEntity[];

/** What the staff timeline reads: the booking's own rows and each attendee's seat rows. */
export const TIMELINE_HISTORY_ENTITIES = [
  ...BOOKING_HISTORY_ENTITIES,
  "SEAT",
] as const satisfies readonly BookingHistoryEntity[];
