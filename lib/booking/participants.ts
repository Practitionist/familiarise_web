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
 * (appointmentId, userId) unique, then a revive of terminal rows; guarded
 * updateMany for status through `transitionParticipant`), so a checkout retry
 * or a webhook redelivery cannot 409 here.
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
  // The revive is the one edge out of a released status, so it widens the
  // from-set explicitly rather than living in the map (#1846 SM-B9). #1852 —
  // the revived seat takes the new purchase's payer org.
  for (const row of data) {
    await transitionParticipant(
      tx,
      { appointmentId, userId: row.userId },
      row.status,
      {
        fromIn: RELEASED_PARTICIPANT_STATUSES,
        data: {
          role: row.role,
          paymentId: row.paymentId,
          organizationId: row.organizationId,
        },
      },
    );
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
  return transitionParticipant(tx, where, "CANCELLED");
}

/**
 * #1846 SM-B9 — the participant lifecycle, keyed by TARGET like every map in
 * `lib/booking/transitions.ts`: `PARTICIPANT_ALLOWED_FROM[to]` lists the only
 * statuses a row may be in when it moves to `to`. Before this the status was a
 * bare updateMany over a caller-supplied WHERE, so a cancel sweep rewrote a
 * seat already REFUNDED back to CANCELLED and the seat's money trail read
 * wrong.
 *
 * HELD is entry-only: a released seat bought again is `recordParticipants`'
 * revive, which widens the from-set explicitly. REFUNDED is terminal. A
 * refund may land after a cancel released the seat, so CANCELLED → REFUNDED
 * is legal and the reverse is not.
 */
export const PARTICIPANT_ALLOWED_FROM: Record<
  ParticipantStatus,
  ParticipantStatus[]
> = {
  HELD: [],
  CONFIRMED: ["HELD"],
  ATTENDED: ["CONFIRMED"],
  CANCELLED: LIVE_PARTICIPANT_STATUSES,
  REFUNDED: [...LIVE_PARTICIPANT_STATUSES, "CANCELLED"],
};

/**
 * Move every participant row `where` selects to `to`, but only rows whose
 * status is in the allowed-from set. The set is ANDed with the caller's WHERE,
 * never merged into it, so a caller that already narrows (a capture confirms
 * `status: "HELD"` only) keeps its narrower set, and a caller that forgot to
 * narrow still cannot make an illegal move.
 *
 * Sweep semantics: matching zero rows is a normal answer (nothing live left,
 * or the row already moved), so this returns the count and never throws.
 * Participant moves write no BookingStatusHistory row; that enum has no
 * participant entity.
 */
export async function transitionParticipant(
  tx: ParticipantTx,
  where: Prisma.AppointmentParticipantWhereInput,
  to: ParticipantStatus,
  opts: {
    /** Narrow or widen the from-set for a flow-specific edge. */
    fromIn?: ParticipantStatus[];
    data?: Omit<
      Prisma.AppointmentParticipantUncheckedUpdateManyInput,
      "status"
    >;
  } = {},
): Promise<number> {
  const fromIn = opts.fromIn ?? PARTICIPANT_ALLOWED_FROM[to];
  const res = await tx.appointmentParticipant.updateMany({
    where: { AND: [where, { status: { in: fromIn } }] },
    data: { status: to, ...opts.data },
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

/**
 * #1852 — which org a user's feedback or support thread on this appointment
 * belongs to. A webinar or class seats B2C attendees and members of several
 * orgs at once, so for an attendee it is the org on THEIR OWN seat (null for a
 * B2C seat), never the host's: a public attendee's rating must not move the
 * host org's quality score, and a sponsor must see feedback on the seats it
 * paid for elsewhere. Anyone without an attendee seat there (the deliverer,
 * staff, an org operator) keeps the appointment's org, as do 1:1 kinds, whose
 * appointment org already is the payer's.
 */
export async function seatOrganizationId(
  tx: ParticipantTx,
  appointment: {
    id: string;
    appointmentType: string;
    organizationId: string | null;
  },
  userId: string,
): Promise<string | null> {
  if (
    appointment.appointmentType !== "WEBINAR" &&
    appointment.appointmentType !== "CLASS"
  ) {
    return appointment.organizationId;
  }
  const seat = await tx.appointmentParticipant.findUnique({
    where: { appointmentId_userId: { appointmentId: appointment.id, userId } },
    select: { role: true, organizationId: true },
  });
  return seat?.role === "CONSULTEE"
    ? seat.organizationId
    : appointment.organizationId;
}
