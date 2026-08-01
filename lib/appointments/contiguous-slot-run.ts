/**
 * Canonical N×30-minute slot atoms for a single session (#1071 / ADR B1).
 *
 * Planner CRUD historically wrote one long SlotOfAppointment spanning the full
 * duration, while SlotAllocationService wrote ceil(hours/0.5) half-hour rows.
 * Reschedule then updated only slotsOfAppointment[0], stranding the rest.
 *
 * Every planner create/update path must go through these helpers so an
 * appointment's live slots always form exactly one contiguous run.
 */

import type { PrismaLike } from "@/lib/prisma";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { groupSlotsIntoRuns, isDeadSlot } from "@/lib/appointments/slots";

export const SLOT_DURATION_MS = 30 * 60 * 1000;

export type ContiguousSlotAtomInput = {
  startsAt: Date;
  durationInHours: number;
  consultantProfileId: string;
  isTentative?: boolean;
  /** User ids to connect on every atom (host + enrolled attendees). */
  userIds?: string[];
};

export type ContiguousSlotAtomCreate = {
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  consultantProfileId: string;
  user?: { connect: Array<{ id: string }> };
};

/**
 * Pure: expand a session start + duration into N half-hour create payloads.
 */
export function buildContiguousSlotAtoms(
  input: ContiguousSlotAtomInput,
): ContiguousSlotAtomCreate[] {
  const { startsAt, durationInHours, consultantProfileId } = input;
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) {
    throw new Error("buildContiguousSlotAtoms: invalid startsAt");
  }
  if (typeof durationInHours !== "number" || durationInHours <= 0) {
    throw new Error("buildContiguousSlotAtoms: durationInHours must be > 0");
  }

  const slotsPerSession =
    SlotCalculationService.getSlotsPerCall(durationInHours);
  const isTentative = input.isTentative ?? false;
  const userIds = [...new Set((input.userIds ?? []).filter(Boolean))];

  const atoms: ContiguousSlotAtomCreate[] = [];
  for (let i = 0; i < slotsPerSession; i++) {
    const atomStart = new Date(startsAt.getTime() + i * SLOT_DURATION_MS);
    const atomEnd = new Date(atomStart.getTime() + SLOT_DURATION_MS);
    atoms.push({
      startsAt: atomStart,
      endsAt: atomEnd,
      isTentative,
      consultantProfileId,
      ...(userIds.length > 0
        ? { user: { connect: userIds.map((id) => ({ id })) } }
        : {}),
    });
  }
  return atoms;
}

/**
 * Live slots on one appointment must form exactly one contiguous run.
 * Throws when the invariant is violated (write-time assert for #1071).
 */
export function assertSingleContiguousLiveRun(
  slots: Array<{
    id: string;
    appointmentId?: string | null;
    startsAt: Date | string;
    endsAt?: Date | string | null;
    isTentative?: boolean | null;
    completionStatus?: string | null;
    deletedAt?: Date | string | null;
  }>,
): void {
  const live = slots.filter((s) => !isDeadSlot(s));
  if (live.length === 0) return;

  const runs = groupSlotsIntoRuns(
    live.map((s) => ({
      ...s,
      appointmentId: s.appointmentId ?? "__single__",
    })),
  );

  if (runs.length !== 1) {
    throw new Error(
      `Appointment live slots must form exactly one contiguous run; found ${runs.length}`,
    );
  }
}

/**
 * Rewrite the appointment's live slot run to `startsAt` + duration.
 *
 * ## Why reconcile instead of deleteMany + recreate?
 *
 * The first #1071 cut hard-deleted live rows and inserted new ones. That fixed
 * the stranded-atom bug, but `MeetingSession` / `Recording` cascade on
 * `SlotOfAppointment` delete (`onDelete: Cascade`). A free webinar (or one
 * whose payments are all FAILED/EXPIRED) still reaches this path, and a host
 * who opened the room once already has a MeetingSession — so a duration-only
 * edit could wipe recordings. The pre-#1071 code updated `[0]` in place and
 * preserved ids; we keep that property for the overlapping prefix.
 *
 * Chosen shape (PR #1091 review):
 * 1. UPDATE the first `min(existingLive, N)` rows' times (ids stay put).
 * 2. CREATE only the delta when duration grows.
 * 3. Soft-retire surplus live rows as `RESCHEDULED` (same stamp the consultee
 *    reschedule route uses) so history + Stream children remain queryable.
 *
 * Dead rows (CANCELLED / RESCHEDULED / deletedAt) are left alone — they are
 * not part of the live run and must not donate their `startsAt` to a
 * duration-only rewrite (that snap-back was the other half of the bug).
 */
export async function replaceContiguousSlotRun(
  // PrismaLike (not Prisma.TransactionClient): the app client is `$extends`,
  // and interactive-tx clients fail assignability against the bare generated
  // type (excessive stack depth / incompatible tx shape in CI).
  tx: PrismaLike,
  args: {
    appointmentId: string;
    startsAt: Date;
    durationInHours: number;
    consultantProfileId: string;
    isTentative?: boolean;
    /** Extra user ids to connect (merged with users already on live slots). */
    extraUserIds?: string[];
  },
): Promise<{ createdCount: number; preservedUserIds: string[] }> {
  const existing = await tx.slotOfAppointment.findMany({
    where: { appointmentId: args.appointmentId },
    orderBy: { startsAt: "asc" },
    include: { user: { select: { id: true } } },
  });

  // Only live rows participate in the run. Users on dead rows are intentionally
  // not re-attached — those seats were already left / cancelled.
  const live = existing.filter((s) => !isDeadSlot(s));
  const preservedUserIds = new Set<string>(args.extraUserIds ?? []);
  for (const slot of live) {
    for (const u of slot.user ?? []) {
      preservedUserIds.add(u.id);
    }
  }
  const userIds = Array.from(preservedUserIds);

  const atoms = buildContiguousSlotAtoms({
    startsAt: args.startsAt,
    durationInHours: args.durationInHours,
    consultantProfileId: args.consultantProfileId,
    isTentative: args.isTentative ?? false,
    userIds,
  });

  const shared = Math.min(live.length, atoms.length);

  // In-place updates: Stream room keys and recordings stay keyed to these ids.
  for (let i = 0; i < shared; i++) {
    const atom = atoms[i];
    await tx.slotOfAppointment.update({
      where: { id: live[i].id },
      data: {
        startsAt: atom.startsAt,
        endsAt: atom.endsAt,
        isTentative: atom.isTentative,
        consultantProfileId: atom.consultantProfileId,
        // `set` replaces the M2M so host + enrolled attendees survive the move.
        ...(userIds.length > 0
          ? { user: { set: userIds.map((id) => ({ id })) } }
          : {}),
      },
    });
  }

  for (let i = shared; i < atoms.length; i++) {
    const atom = atoms[i];
    await tx.slotOfAppointment.create({
      data: {
        appointmentId: args.appointmentId,
        startsAt: atom.startsAt,
        endsAt: atom.endsAt,
        isTentative: atom.isTentative,
        consultantProfileId: atom.consultantProfileId,
        ...(atom.user ? { user: atom.user } : {}),
      },
    });
  }

  // Duration shrunk: mark leftover live atoms RESCHEDULED rather than delete.
  // Hard-delete would cascade MeetingSession → Recording for those rows.
  for (let i = shared; i < live.length; i++) {
    await tx.slotOfAppointment.update({
      where: { id: live[i].id },
      data: {
        isTentative: true,
        completionStatus: "RESCHEDULED",
      },
    });
  }

  // SQL `NOT IN (...)` excludes NULL completionStatus, so we OR-null explicitly.
  const createdLive = await tx.slotOfAppointment.findMany({
    where: {
      appointmentId: args.appointmentId,
      deletedAt: null,
      OR: [
        { completionStatus: null },
        { completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] } },
      ],
    },
    orderBy: { startsAt: "asc" },
  });
  assertSingleContiguousLiveRun(
    createdLive.map((s) => ({ ...s, appointmentId: args.appointmentId })),
  );

  return {
    createdCount: createdLive.length,
    preservedUserIds: userIds,
  };
}
