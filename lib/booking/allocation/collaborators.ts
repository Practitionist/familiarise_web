// Refuses times an accepted co-host is already committed elsewhere.

import type { Tx } from "@/lib/prisma";
import { EventType } from "@/utils/scheduling-engine/types";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { assertCollaboratorsAvailableForWindows } from "@/lib/collaborators/availability";

/**
 * AE-2 (#784) — refuse to commit these times when an ACCEPTED co-host on a
 * webinar/class plan is already busy. Co-hosts are not slot participants, so
 * neither `occurrence_no_confirmed_overlap` nor the owner-scoped validators see
 * them; only this guard does. No-op for consultations/subscriptions (no
 * collaborators) and for plans with no accepted co-hosts.
 *
 * Contiguous 30-minute atoms are merged back into session windows by the
 * helper, so one query covers a whole class allocation.
 */
export async function assertCollaboratorsFree(
  tx: Tx,
  eventType: EventType,
  planId: string | null | undefined,
  slotStarts: Date[],
  excludeAppointmentIds: string[],
): Promise<void> {
  if (eventType !== "webinar" && eventType !== "class") return;
  if (!planId || slotStarts.length === 0) return;

  await assertCollaboratorsAvailableForWindows(tx, {
    planType: eventType === "webinar" ? "WEBINAR" : "CLASS",
    planId,
    windows: slotStarts.map((startsAt) => ({
      startsAt,
      endsAt: new Date(startsAt.getTime() + SCHEDULING_INTERVAL_MS),
    })),
    excludeAppointmentIds,
  });
}
