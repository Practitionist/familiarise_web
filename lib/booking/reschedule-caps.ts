/**
 * Per-side reschedule caps, counted from the release history: every reschedule
 * releases its sessions to RESCHEDULED in one act stamped with one instant, so
 * the distinct instants on a side are its reschedules, proposal or not. A
 * withdrawal restores the original time, so withdrawn proposals cost nothing.
 */
import type { RescheduleInitiatorRole } from "@prisma/client";

import type { Tx } from "@/lib/prisma";

/** Consultee reschedules per baseline session. */
export const MAX_CONSULTEE_RESCHEDULES = 2;
/** Expert-initiated reschedules one booking allows; the next answers 409. */
export const MAX_EXPERT_RESCHEDULES = 2;

type CapTx = Pick<Tx, "bookingStatusHistory" | "rescheduleRequest">;

export async function priorReschedules(
  tx: CapTx,
  args: {
    appointmentId: string;
    role: RescheduleInitiatorRole;
    /** The side's known people: its party and the current actor. */
    sideUserIds: string[];
  },
): Promise<number> {
  const initiators = await tx.rescheduleRequest.findMany({
    where: { appointmentId: args.appointmentId, initiatorRole: args.role },
    select: { initiatedById: true, status: true },
  });
  const side = new Set([
    ...args.sideUserIds,
    ...initiators.map((r) => r.initiatedById),
  ]);
  const releases = await tx.bookingStatusHistory.groupBy({
    by: ["createdAt"],
    where: {
      appointmentId: args.appointmentId,
      entity: "OCCURRENCE",
      toStatus: "RESCHEDULED",
      actorUserId: { in: [...side] },
    },
  });
  const withdrawn = initiators.filter((r) => r.status === "WITHDRAWN").length;
  return Math.max(0, releases.length - withdrawn);
}
