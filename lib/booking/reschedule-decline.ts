import type { Tx } from "@/lib/prisma";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "./transitions";

/** Audit attribution for the DECLINED history rows (#1322 A12). */
export interface DeclineAuditMeta {
  actorUserId?: string | null;
  reason?: string | null;
  organizationId?: string | null;
}

/**
 * Close every live reschedule proposal on a booking that is ending. Leaving one
 * open keeps `openForAppointmentId` reserved forever and lets the expiry sweep
 * act on a dead booking (#1383). Shared by the cancel route, the abandon door,
 * moderation and the maintenance freeze (#1846) so each ending declines the
 * same way and writes the same history row.
 *
 * The helper CASes one row by id — hence the read — and releases the
 * reservation itself on every terminal target. Returns how many it declined.
 */
export async function declineOpenReschedules(
  tx: Pick<Tx, "rescheduleRequest" | "bookingStatusHistory">,
  appointmentId: string,
  auditMeta: DeclineAuditMeta = {},
): Promise<number> {
  const openProposals = await tx.rescheduleRequest.findMany({
    where: { appointmentId, status: { in: RESCHEDULE_OPEN_STATUSES } },
    select: { id: true },
  });
  let declined = 0;
  for (const proposal of openProposals) {
    try {
      await transitionRescheduleRequest(tx, {
        ...auditMeta,
        appointmentId,
        where: { id: proposal.id },
        to: "DECLINED",
        fromIn: RESCHEDULE_OPEN_STATUSES,
      });
      declined += 1;
    } catch (err) {
      // A writer without the appointment lock (the expiry sweep before #1846,
      // a maintenance freeze) can answer the proposal between the read and
      // this CAS. The booking still ends with no open proposal, which is the
      // point, so the ending must not fail over it.
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }
  return declined;
}
