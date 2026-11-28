/** Where a session's "Report a problem" entry goes: that session's own report page, once it has ended. */

import { caseKeyOf } from "@/lib/support/case-key";

const DEAD = new Set(["CANCELLED", "RESCHEDULED"]);

export function sessionReportHref(
  supportRequestsBase: string,
  bookingAppointmentId: string,
  session: {
    occurrenceId: string;
    appointmentId: string | null;
    endsAt: Date | null;
    isTentative: boolean;
    completionStatus: string | null;
  },
  now: Date,
): string | null {
  if (
    session.isTentative ||
    !session.endsAt ||
    session.endsAt > now ||
    DEAD.has(session.completionStatus ?? "")
  )
    return null;
  const key = caseKeyOf({
    kind: "booking",
    id: session.appointmentId ?? bookingAppointmentId,
  });
  return `${supportRequestsBase}/${key}?intent=NO_SHOW&occurrence=${encodeURIComponent(session.occurrenceId)}`;
}
