/**
 * A platform operator (STAFF or ADMIN) who is not a party to a booking
 * reschedules it only through the audited door at
 * `/api/staff/appointments/[id]/reschedule`. The door grants the participant
 * reschedule route one request object; the route refuses a privileged
 * non-participant whose request carries no grant.
 */

import prisma from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

const grants = new WeakMap<Request, { opsActionId: string }>();

export function grantPlatformReschedule(request: Request, opsActionId: string) {
  grants.set(request, { opsActionId });
}

export function platformRescheduleGrant(
  request: Request,
): { opsActionId: string } | null {
  return grants.get(request) ?? null;
}

/** The booking as the operator found it, for the door's audit row. */
export async function platformRescheduleBefore(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      appointmentType: true,
      consultation: { select: { status: true } },
      subscription: { select: { status: true } },
      webinar: { select: { status: true } },
      class: { select: { status: true } },
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          completionStatus: true,
        },
      },
    },
  });
  if (!appointment)
    throw new OpsRefusal("NOT_FOUND", "Appointment not found.", 404);
  const parent =
    appointment.consultation ??
    appointment.subscription ??
    appointment.webinar ??
    appointment.class;
  return {
    appointmentType: appointment.appointmentType,
    status: parent?.status ?? null,
    sessions: appointment.occurrences.map((occurrence) => ({
      id: occurrence.id,
      startsAt: occurrence.startsAt.toISOString(),
      endsAt: occurrence.endsAt.toISOString(),
      completionStatus: occurrence.completionStatus,
    })),
  };
}
