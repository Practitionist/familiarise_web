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
 * Delete live (non-CANCELLED / non-RESCHEDULED) slots on the appointment and
 * recreate a contiguous N-atom run from `startsAt` + duration. Preserves
 * enrolled users from the previous live rows.
 */
export async function replaceContiguousSlotRun(
  // PrismaLike (not Prisma.TransactionClient) — the app client is extended
  // and interactive-tx clients fail assignability against the bare type.
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

  const live = existing.filter((s) => !isDeadSlot(s));
  const preservedUserIds = new Set<string>(args.extraUserIds ?? []);
  for (const slot of live) {
    for (const u of slot.user ?? []) {
      preservedUserIds.add(u.id);
    }
  }

  if (live.length > 0) {
    await tx.slotOfAppointment.deleteMany({
      where: {
        appointmentId: args.appointmentId,
        completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      },
    });
  }

  const atoms = buildContiguousSlotAtoms({
    startsAt: args.startsAt,
    durationInHours: args.durationInHours,
    consultantProfileId: args.consultantProfileId,
    isTentative: args.isTentative ?? false,
    userIds: Array.from(preservedUserIds),
  });

  for (const atom of atoms) {
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

  const createdLive = await tx.slotOfAppointment.findMany({
    where: {
      appointmentId: args.appointmentId,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
    },
    orderBy: { startsAt: "asc" },
  });
  assertSingleContiguousLiveRun(
    createdLive.map((s) => ({ ...s, appointmentId: args.appointmentId })),
  );

  return {
    createdCount: createdLive.length,
    preservedUserIds: Array.from(preservedUserIds),
  };
}
