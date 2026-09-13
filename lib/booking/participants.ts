import type { Tx } from "@/lib/prisma";
import type {
  ParticipantRole,
  ParticipantStatus,
  Prisma,
} from "@prisma/client";

/**
 * #1319 A9 / #1554 — AppointmentParticipant is the ONLY participant list.
 *
 * Every creation path records the participant edge here, in the SAME
 * transaction, and every roster or capacity read goes through
 * `liveParticipant` below: the per-occurrence user join is gone (#1554), so a
 * released seat is a CANCELLED/REFUNDED row rather than a disconnect. The
 * pre-MVP reset starts from clean data, so the table is never backfilled.
 *
 * All writes are idempotent by construction (createMany skipDuplicates on the
 * (appointmentId, userId) unique, then a revive of terminal rows; updateMany
 * for status), so a checkout retry or a webhook redelivery cannot 409 here.
 */

export interface ParticipantEntry {
  userId: string;
  role: ParticipantRole;
  status?: ParticipantStatus;
  paymentId?: string | null;
}

type ParticipantTx = Pick<Tx, "appointmentParticipant">;

export async function recordParticipants(
  tx: ParticipantTx,
  appointmentId: string,
  entries: ParticipantEntry[],
  opts: { organizationId?: string | null; status?: ParticipantStatus } = {},
): Promise<void> {
  if (entries.length === 0) return;
  // Dedupe on userId: a consultant booking their own slot as consultee is
  // rejected upstream, but the join accepts one user once and so must we.
  const seen = new Set<string>();
  const data = entries
    .filter((e) => (seen.has(e.userId) ? false : (seen.add(e.userId), true)))
    .map((e) => ({
      appointmentId,
      userId: e.userId,
      role: e.role,
      status: e.status ?? opts.status ?? "HELD",
      paymentId: e.paymentId ?? null,
      organizationId: opts.organizationId ?? null,
    }));
  await tx.appointmentParticipant.createMany({ data, skipDuplicates: true });
  // A seat released earlier (CANCELLED/REFUNDED) and bought again is the same
  // (appointmentId, userId) row, so skipDuplicates alone would leave it dead.
  for (const row of data) {
    await tx.appointmentParticipant.updateMany({
      where: {
        appointmentId,
        userId: row.userId,
        status: { in: RELEASED_PARTICIPANT_STATUSES },
      },
      data: {
        status: row.status,
        role: row.role,
        paymentId: row.paymentId,
        organizationId: row.organizationId,
      },
    });
  }
}

/** Statuses under which a participant row still holds its seat. */
export const LIVE_PARTICIPANT_STATUSES: ParticipantStatus[] = [
  "HELD",
  "CONFIRMED",
  "ATTENDED",
];

/** Statuses that mean the seat was given back; the old m:n "disconnect". */
export const RELEASED_PARTICIPANT_STATUSES: ParticipantStatus[] = [
  "CANCELLED",
  "REFUNDED",
];

/** The roster predicate: `participants: { some: liveParticipant(userId) }`. */
export function liveParticipant(
  userId?: string,
): Prisma.AppointmentParticipantWhereInput {
  return {
    ...(userId ? { userId } : {}),
    status: { in: LIVE_PARTICIPANT_STATUSES },
  };
}

/** Release one user's seat on the appointments `where` selects (#1554). */
export async function releaseParticipant(
  tx: ParticipantTx,
  where: Prisma.AppointmentParticipantWhereInput,
): Promise<number> {
  return setParticipantStatus(
    tx,
    { ...where, status: { in: LIVE_PARTICIPANT_STATUSES } },
    "CANCELLED",
  );
}

export async function setParticipantStatus(
  tx: ParticipantTx,
  where: Prisma.AppointmentParticipantWhereInput,
  to: ParticipantStatus,
  data: Omit<
    Prisma.AppointmentParticipantUpdateManyMutationInput,
    "status"
  > = {},
): Promise<number> {
  const res = await tx.appointmentParticipant.updateMany({
    where,
    data: { status: to, ...data },
  });
  return res.count;
}

/** Stamp the Payment that funded every participant row of one appointment. */
export async function linkParticipantsToPayment(
  tx: ParticipantTx,
  appointmentId: string,
  paymentId: string,
  userId?: string,
): Promise<void> {
  await tx.appointmentParticipant.updateMany({
    where: { appointmentId, paymentId: null, ...(userId ? { userId } : {}) },
    data: { paymentId },
  });
}
