import type { TAppointmentOccurrence } from "@/types/appointment";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableOccurrence as getJoinableOccurrenceShared,
} from "@/lib/appointments/occurrences";

/** Consultant join-window resolution — thin wrapper over the shared occurrence
 *  predicate (lib/appointments/occurrences) with the consultant's 15-min window. */
export function getJoinableOccurrence(
  occurrences: TAppointmentOccurrence[],
): TAppointmentOccurrence | null {
  return getJoinableOccurrenceShared(occurrences, {
    joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
  });
}
