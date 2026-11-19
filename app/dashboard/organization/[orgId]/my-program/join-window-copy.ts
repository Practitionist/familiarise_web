import { CONSULTEE_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";

// A member joins as an attendee, so the attendee window gates their Join.
const JOIN_WINDOW_MINUTES = CONSULTEE_JOIN_WINDOW_MS / 60_000;

export const JOIN_OPENS_LABEL = `Opens ${JOIN_WINDOW_MINUTES} min before`;
export const JOIN_WINDOW_NOTE = `when the room opens (within ${JOIN_WINDOW_MINUTES} minutes of the start time).`;
