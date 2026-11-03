// Approving a paid request confirms the times it already holds; they are
// confirmed only while no other occupying row has landed on either calendar.

import type { Tx } from "@/lib/prisma";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { liveParticipant } from "@/lib/booking/participants";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";

/** Party-neutral: the other booking may be the consultee's own, with someone else. */
export const HELD_TIME_TAKEN =
  "Another booking now holds this time. Decline this request or propose a new time.";

export async function assertHeldTimesStillFree(
  tx: Tx,
  appointmentId: string,
): Promise<void> {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      participants: {
        where: liveParticipant(),
        select: { userId: true, role: true },
      },
      occurrences: {
        where: { completionStatus: "SCHEDULED", deletedAt: null },
        select: { startsAt: true, endsAt: true, consultantProfileId: true },
      },
    },
  });
  const host = appointment?.participants.find((p) => p.role === "CONSULTANT");
  if (!appointment || !host) return;
  const consultee = appointment.participants.find(
    (p) => p.role === "CONSULTEE",
  );
  const slots = appointment.occurrences.flatMap((o) => {
    const starts: Date[] = [];
    for (
      let t = o.startsAt.getTime();
      t < o.endsAt.getTime();
      t += SCHEDULING_INTERVAL_MS
    ) {
      starts.push(new Date(t));
    }
    return starts;
  });
  if (slots.length === 0) return;
  const recheck = await new ScheduleValidationService(tx).revalidateConflicts(
    slots,
    host.userId,
    [appointmentId],
    consultee?.userId,
    undefined,
    appointment.occurrences[0]?.consultantProfileId ?? undefined,
  );
  if (!recheck.isValid) {
    throw new BookingRuleError("SCHEDULE_CONFLICT", HELD_TIME_TAKEN);
  }
}
