// Host-time writers that move or add time on an expert's calendar outside the
// allocator (event create/publish/re-time, make-up, co-host accept, meeting
// extension) take the same slot atoms as checkout and the allocator.

import prisma from "@/lib/prisma";
import { CollaboratorStatus } from "@prisma/client";
import { ConsultantScheduleConflictError } from "@/lib/collaborators/availability";
import {
  extendSlotInterval,
  tryLockSlotBatch,
  unlockSlotInterval,
  type SlotBatchEntry,
} from "@/utils/appointmentlock";

/** Outlives one Serializable attempt (maxWait + timeout) with margin; renewed per attempt. */
export const HOST_SLOT_BATCH_TTL_MS = 60_000;

/** Another writer holds one of the atoms right now: transient, unlike a standing conflict. */
export class HostTimeHeldError extends ConsultantScheduleConflictError {
  constructor() {
    super(
      "That time is being booked right now. Pick another time or try again in a moment.",
    );
    this.name = "HostTimeHeldError";
  }
}

/** The ACCEPTED co-hosts of a webinar or class plan. */
export async function acceptedCohostProfileIds(
  planType: "WEBINAR" | "CLASS",
  planId: string,
): Promise<string[]> {
  const rows = await prisma.collaborator.findMany({
    where: {
      ...(planType === "WEBINAR"
        ? { webinarPlanId: planId }
        : { classPlanId: planId }),
      status: CollaboratorStatus.ACCEPTED,
    },
    select: { consultantProfileId: true },
  });
  return rows.map((r) => r.consultantProfileId);
}

/** Every window × every profile, as batch entries. */
export function hostBatchEntries(
  profileIds: readonly string[],
  windows: readonly { startsAt: Date; endsAt: Date }[],
): SlotBatchEntry[] {
  return [...new Set(profileIds)].flatMap((consultantProfileId) =>
    windows.map((w) => ({
      consultantProfileId,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
    })),
  );
}

/** The held atoms could not be extended to cover the time a write is about to claim. */
export class HostTimeNotRetainedError extends HostTimeHeldError {
  constructor() {
    super();
    this.name = "HostTimeNotRetainedError";
  }
}

const keepNothing = () => undefined;

/**
 * Run `fn` holding every atom of `entries` (no wait: a held atom is a 409
 * schedule conflict). `renew` re-arms the batch at the top of each
 * Serializable attempt and throws when it was lost. `retainUntil` extends the
 * batch to `until` before the durable write it protects, throwing
 * `HostTimeNotRetainedError` when it cannot; the returned `keep` leaves the
 * batch held after `fn`. Without `keep` the batch unlocks, including when `fn`
 * throws or its write loses. Empty entries run `fn` unlocked.
 */
export async function withHostSlotBatch<T>(
  entries: readonly SlotBatchEntry[],
  fn: (
    renew: () => Promise<void>,
    retainUntil: (until: Date) => Promise<() => void>,
  ) => Promise<T>,
): Promise<T> {
  if (entries.length === 0)
    return fn(
      () => Promise.resolve(),
      () => Promise.resolve(keepNothing),
    );
  const outcome = await tryLockSlotBatch(entries, HOST_SLOT_BATCH_TTL_MS);
  if (!outcome.ok) throw new HostTimeHeldError();
  const grant = outcome.grant;
  let kept = false;
  try {
    return await fn(
      async () => {
        if (!(await extendSlotInterval(grant, HOST_SLOT_BATCH_TTL_MS))) {
          throw new HostTimeHeldError();
        }
      },
      async (until) => {
        const ttl = until.getTime() - Date.now();
        if (ttl <= 0 || !(await extendSlotInterval(grant, ttl))) {
          throw new HostTimeNotRetainedError();
        }
        return () => {
          kept = true;
        };
      },
    );
  } finally {
    if (!kept) await unlockSlotInterval(grant);
  }
}
