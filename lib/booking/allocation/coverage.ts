// The allocator re-reads the host's published availability inside its write
// transaction, so a shrink that commits after the search is never booked into.

import type { Tx } from "@/lib/prisma";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "@/utils/scheduling-engine/availabilityCoverage";

/** Every chosen interval start still sits inside the host's published availability. */
export async function assertSlotsStillPublished(
  tx: Tx,
  consultantProfileId: string,
  slotStarts: readonly Date[],
): Promise<void> {
  if (slotStarts.length === 0) return;
  const sorted = [...slotStarts].sort((a, b) => a.getTime() - b.getTime());
  const last = sorted[sorted.length - 1];
  const { weeklyRows, customRows } = await loadPublishedCoverage(
    tx,
    consultantProfileId,
    sorted[0],
    new Date(last.getTime() + SCHEDULING_INTERVAL_MS),
  );
  const atoms = sorted.flatMap((start) =>
    windowAtoms(start, new Date(start.getTime() + SCHEDULING_INTERVAL_MS)),
  );
  if (findUncoveredAtom(atoms, weeklyRows, customRows)) {
    throw new AllocationConflictError(
      "The availability changed while these times were being booked. Pick times inside the current availability and try again.",
      "AVAILABILITY_CHANGED",
    );
  }
}
