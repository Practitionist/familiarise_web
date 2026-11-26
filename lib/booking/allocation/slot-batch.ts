// The allocator's slot batch: every atom of every profile an allocation makes
// busy, taken all-or-nothing after the search and before the write.

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { acceptedCohostProfileIds } from "@/lib/booking/host-slot-batch";
import {
  lockHostTimeInTx,
  type HeldHostTime,
} from "@/lib/booking/allocation/host-time-locks";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import type { EventType } from "@/utils/scheduling-engine/types";
import {
  byCodeUnit,
  extendSlotInterval,
  parseSlotKey,
  tryLockSlotBatch,
  type SlotBatchEntry,
  type SlotBatchGrant,
} from "@/utils/appointmentlock";

/** Outlives one write transaction (maxWait + timeout) with margin; renewed at its top. */
export const ALLOCATION_SLOT_BATCH_TTL_MS =
  ALLOCATION_TX_MAX_WAIT_MS + ALLOCATION_TX_TIMEOUT_MS + 15_000;

/** Auto mode re-searches at most this many times around times another writer holds. */
export const MAX_ALLOCATION_RESEARCHES = 2;

/** A refused batch for picked times: names the taken times (never who holds them). */
export class SlotsTakenError extends AllocationConflictError {
  constructor(readonly takenSlotStarts: string[]) {
    super(
      "Some of the times you picked were just taken. Pick other times for those sessions and try again.",
      "TIMES_TAKEN",
    );
  }
}

/** Auto mode found no free set of times after its re-searches; retrying is safe. */
export class AllocationRaceError extends AllocationConflictError {
  readonly retryAfterSeconds = 5;
  constructor() {
    super(
      "These times are being booked right now. Please try again in a moment.",
      "ALLOCATION_RACE",
    );
  }
}

/**
 * Every profile an allocation makes busy: the host, each ACCEPTED co-host of a
 * webinar/class plan, and the consultee's own profile when they are an expert
 * too (their own calendar is their buyer-side calendar).
 */
export async function allocationBatchProfiles(args: {
  eventType: EventType;
  planId: string | null | undefined;
  consultantProfileId: string;
  consulteeUserId: string | null | undefined;
}): Promise<string[]> {
  const profiles = new Set<string>([args.consultantProfileId]);
  if (
    (args.eventType === "webinar" || args.eventType === "class") &&
    args.planId
  ) {
    const cohosts = await acceptedCohostProfileIds(
      args.eventType === "webinar" ? "WEBINAR" : "CLASS",
      args.planId,
    );
    for (const id of cohosts) profiles.add(id);
  }
  if (args.consulteeUserId) {
    const self = await prisma.consultantProfile.findUnique({
      where: { userId: args.consulteeUserId },
      select: { id: true },
    });
    if (self) profiles.add(self.id);
  }
  return [...profiles];
}

/** One 30-minute entry per chosen interval start per profile. */
export function allocationBatchEntries(
  slotStarts: readonly Date[],
  profileIds: readonly string[],
): SlotBatchEntry[] {
  return profileIds.flatMap((consultantProfileId) =>
    slotStarts.map((startsAt) => ({
      consultantProfileId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + SCHEDULING_INTERVAL_MS),
    })),
  );
}

/** The interval starts (ISO, any profile) a refused batch found held. */
export function heldSlotStartsOf(heldKeys: readonly string[]): string[] {
  const starts = new Set<string>();
  for (const key of heldKeys) {
    const parsed = parseSlotKey(key);
    if (parsed) starts.add(parsed.startsAt.toISOString());
  }
  return [...starts].sort(byCodeUnit);
}

/** Picked times (manual / requested): no wait, no re-search; a held atom is a typed 409. */
export async function lockPickedSlots(
  slotStarts: readonly Date[],
  profileIds: readonly string[],
): Promise<SlotBatchGrant> {
  const outcome = await tryLockSlotBatch(
    allocationBatchEntries(slotStarts, profileIds),
    ALLOCATION_SLOT_BATCH_TTL_MS,
  );
  if (!outcome.ok)
    throw new SlotsTakenError(heldSlotStartsOf(outcome.heldKeys));
  return outcome.grant;
}

/**
 * The write transaction's first statement: Postgres try-locks over the atoms of
 * the Redis batch, before the event's advisory lock and every row lock. A held
 * picked time answers TIMES_TAKEN naming it; auto mode passes its own race.
 */
export async function lockAllocationTimesInTx(
  tx: Pick<Tx, "$queryRaw">,
  slotStarts: readonly Date[],
  profileIds: readonly string[],
  refusal: (held: HeldHostTime) => Error = (held) =>
    new SlotsTakenError([held.startsAt.toISOString()]),
): Promise<void> {
  await lockHostTimeInTx(
    tx,
    allocationBatchEntries(slotStarts, profileIds),
    refusal,
  );
}

/** Re-arm at the top of the write; a lost batch aborts before anything is written. */
export async function renewAllocationBatch(
  grant: SlotBatchGrant | null,
): Promise<void> {
  if (!grant) return;
  if (!(await extendSlotInterval(grant, ALLOCATION_SLOT_BATCH_TTL_MS))) {
    throw new AllocationRaceError();
  }
}
