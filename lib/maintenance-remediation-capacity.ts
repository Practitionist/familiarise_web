import type { Tx } from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";

// Operational bounds for this synchronous cancellation path; these are not plan limits.
export const MAINTENANCE_REMEDIATION_CAPACITY = {
  participants: 8,
  occurrences: 12,
  payments: 10,
  recipients: 10,
};

export class MaintenanceRemediationCapacityError extends Error {}

export function assertRemediationCounts(
  appointmentId: string,
  counts: {
    participants: number;
    occurrences: number;
    payments: number;
    recipients?: number;
  },
): void {
  if (
    counts.participants > MAINTENANCE_REMEDIATION_CAPACITY.participants ||
    counts.occurrences > MAINTENANCE_REMEDIATION_CAPACITY.occurrences ||
    counts.payments > MAINTENANCE_REMEDIATION_CAPACITY.payments ||
    (counts.recipients ?? 0) > MAINTENANCE_REMEDIATION_CAPACITY.recipients
  )
    throw new MaintenanceRemediationCapacityError(
      `Booking ${appointmentId} exceeds automatic maintenance remediation capacity. Larger bookings are unsupported here and need a reviewed cancellation procedure; no cancellation or refund was applied.`,
    );
}

export async function assertMaintenanceRemediationCapacity(
  db: { appointment: Pick<Tx["appointment"], "findMany"> },
  appointmentIds: string[],
): Promise<void> {
  const bookings = await db.appointment.findMany({
    where: { id: { in: appointmentIds } },
    select: {
      id: true,
      _count: {
        select: {
          participants: { where: liveParticipant() },
          occurrences: { where: { deletedAt: null, isTentative: false } },
          payment: true,
        },
      },
    },
  });
  for (const booking of bookings)
    assertRemediationCounts(booking.id, {
      participants: booking._count.participants,
      occurrences: booking._count.occurrences,
      payments: booking._count.payment,
    });
}
