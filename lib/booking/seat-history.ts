import { z } from "zod";
import type { ParticipantStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";

/** Why an event seat moved; every SEAT history row carries exactly one. */
export const SEAT_HISTORY_REASONS = [
  "registered",
  "self_leave",
  "organiser_removal",
  "conduct_removal",
  "block_lifted",
  "rejoined",
  "refunded",
] as const;

export const SeatHistoryReasonSchema = z.enum(SEAT_HISTORY_REASONS);
export type SeatHistoryReason = z.infer<typeof SeatHistoryReasonSchema>;

/** What a seat move records beside its status: the reason and who acted (null for a sweep). */
export interface SeatHistoryNote {
  reason: SeatHistoryReason;
  actorUserId: string | null;
}

export interface SeatHistoryRow {
  participantId: string;
  appointmentId: string;
  fromStatus: string;
  toStatus: ParticipantStatus;
}

/** Appends one SEAT row per moved seat, on the caller's transaction. */
export async function appendSeatHistory(
  tx: Pick<Tx, "bookingStatusHistory">,
  rows: readonly SeatHistoryRow[],
  note: SeatHistoryNote,
  at: Date = new Date(),
): Promise<void> {
  if (rows.length === 0) return;
  await tx.bookingStatusHistory.createMany({
    data: rows.map((row) => ({
      entity: "SEAT" as const,
      entityId: row.participantId,
      appointmentId: row.appointmentId,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      reason: note.reason,
      actorUserId: note.actorUserId,
      createdAt: at,
    })),
  });
}

/** One step of a seat's trail, oldest first; `at` is ISO-8601. */
export interface SeatTrailStep {
  reason: SeatHistoryReason;
  at: string;
}

/** Each seat's trail, oldest first, keyed by participant id; rows with an unknown reason are skipped. */
export async function readSeatTrails(
  db: Pick<Tx, "bookingStatusHistory">,
  participantIds: readonly string[],
): Promise<Map<string, SeatTrailStep[]>> {
  const trails = new Map<string, SeatTrailStep[]>();
  if (participantIds.length === 0) return trails;
  const rows = await db.bookingStatusHistory.findMany({
    where: {
      entity: "SEAT",
      entityId: { in: [...participantIds] },
      reason: { in: [...SEAT_HISTORY_REASONS] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { entityId: true, reason: true, createdAt: true },
  });
  for (const row of rows) {
    const reason = SeatHistoryReasonSchema.safeParse(row.reason);
    if (!reason.success) continue;
    const steps = trails.get(row.entityId) ?? [];
    steps.push({ reason: reason.data, at: row.createdAt.toISOString() });
    trails.set(row.entityId, steps);
  }
  return trails;
}
