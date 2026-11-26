/**
 * The buyer's trial pick (`POST /api/trials`): the consultee chooses a start
 * from the expert's open windows, and the time is written in the same
 * transaction as the trial. A free trial is confirmed at once (SCHEDULED, a
 * confirmed session); a paid one holds the time as a tentative session while
 * AWAITING_PAYMENT, and the capture webhook confirms it (`transitionTrial`
 * AWAITING_PAYMENT → SCHEDULED, then `confirmExistingAppointment`).
 */
import {
  AppointmentsType,
  OccurrenceCompletionStatus,
  TrialStatus,
  type Prisma,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { lockHostTimeInTx } from "@/lib/booking/allocation/host-time-locks";
import { recordParticipants } from "@/lib/booking/participants";
import { appendCreationHistory } from "@/lib/booking/transitions";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { blockingTrialWhere } from "@/lib/trials/eligibility";
import { payWindowEnd } from "@/lib/payments/operations/approval-payment";
import {
  TRIAL_WINDOW_REFUSAL_COPY,
  TRIAL_WINDOW_REFUSAL_STATUS,
  trialWindowRefusal,
  type TrialWindowRefusal,
} from "@/lib/trials/slot-check";
import {
  lockConsulteeBooking,
  lockSlotBatch,
  unlockConsulteeBooking,
  unlockSlotBooking,
  type SlotBatchEntry,
  type SlotBatchGrant,
} from "@/utils/appointmentlock";

/** The picked time was refused inside the transaction; nothing was written. */
export class TrialTimeRefusedError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: TrialWindowRefusal) {
    super(TRIAL_WINDOW_REFUSAL_COPY[code]);
    this.name = "TrialTimeRefusedError";
    this.httpStatus = TRIAL_WINDOW_REFUSAL_STATUS[code];
  }
}

/** A learner may request this many trials in any 24 hours, across every expert. */
export const MAX_TRIALS_PER_DAY = 3;
const TRIAL_DAY_MS = 24 * 60 * 60 * 1000;

/** The learner has used today's trial requests; nothing was written. */
export class TrialDailyLimitError extends Error {
  /** `retryAt`: when the oldest counted request leaves the 24 hours. */
  constructor(readonly retryAt: Date) {
    super("You've reached today's trial request limit.");
    this.name = "TrialDailyLimitError";
  }
}

/** The pair already holds a live or delivered trial; nothing was written. */
export class TrialPairHeldError extends Error {
  constructor() {
    super("The pair already holds a live or delivered trial");
    this.name = "TrialPairHeldError";
  }
}

export const TRIAL_CREATED_INCLUDE = {
  consulteeProfile: {
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  },
  consultantProfile: {
    select: {
      ...consultantPublicScalars,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  },
  subscriptionPlan: true,
} satisfies Prisma.TrialInclude;

export interface BookTrialArgs {
  consulteeProfileId: string;
  consultantProfileId: string;
  subscriptionPlanId: string;
  notes?: string | null;
  organizationId: string | null;
  consulteeUserId: string;
  consultantUserId: string;
  /** A priced trial holds its time until the capture confirms it. */
  paid: boolean;
  /** The plan's trial price the request was checked against, agreed on the row. */
  agreedPricePaise: number;
  startsAt: Date;
  endsAt: Date;
  now?: Date;
}

/** Writes the trial, its appointment and its session on the caller's transaction;
 *  the caller holds the consultee lock and the window's slot atoms. */
export async function bookTrialInTx(tx: Tx, args: BookTrialArgs) {
  const now = args.now ?? new Date();
  // Counted under the caller's consultee lock, in the transaction that
  // inserts, so two requests cannot both take the day's last trial.
  const requestedToday = await tx.trial.findMany({
    where: {
      consulteeProfileId: args.consulteeProfileId,
      requestedAt: { gt: new Date(now.getTime() - TRIAL_DAY_MS) },
    },
    orderBy: { requestedAt: "desc" },
    take: MAX_TRIALS_PER_DAY,
    select: { requestedAt: true },
  });
  if (requestedToday.length >= MAX_TRIALS_PER_DAY) {
    const oldest = requestedToday[requestedToday.length - 1].requestedAt;
    throw new TrialDailyLimitError(new Date(oldest.getTime() + TRIAL_DAY_MS));
  }

  // Re-read under the caller's consultee lock, so a rival request for the pair has committed.
  const held = await tx.trial.findFirst({
    where: blockingTrialWhere({
      consulteeProfileId: args.consulteeProfileId,
      consultantProfileId: args.consultantProfileId,
    }),
    select: { id: true },
  });
  if (held) throw new TrialPairHeldError();

  const refusal = await trialWindowRefusal(tx, {
    consultantProfileId: args.consultantProfileId,
    consultantUserId: args.consultantUserId,
    consulteeUserId: args.consulteeUserId,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    selfHoldAppointmentIds: [],
  });
  if (refusal) throw new TrialTimeRefusedError(refusal);

  // consultantProfileId keeps a confirmed session inside the
  // occurrence_no_confirmed_overlap constraint; a paid hold is tentative, so
  // the slot atoms and the occupancy read above are what serialise it.
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.TRIAL,
      occurrences: {
        create: {
          ordinal: 1,
          startsAt: args.startsAt,
          endsAt: args.endsAt,
          isTentative: args.paid,
          completionStatus: OccurrenceCompletionStatus.SCHEDULED,
          consultantProfileId: args.consultantProfileId,
        },
      },
    },
    select: { id: true },
  });
  await recordParticipants(
    tx,
    appointment.id,
    [
      { userId: args.consulteeUserId, role: "CONSULTEE" },
      { userId: args.consultantUserId, role: "CONSULTANT" },
    ],
    {
      organizationId: args.organizationId,
      status: args.paid ? "HELD" : "CONFIRMED",
    },
  );

  // The row is born in its final state: a free trial is confirmed, a paid one holds its time until paid.
  const to = args.paid ? TrialStatus.AWAITING_PAYMENT : TrialStatus.SCHEDULED;
  const created = await tx.trial.create({
    data: {
      consulteeProfileId: args.consulteeProfileId,
      consultantProfileId: args.consultantProfileId,
      subscriptionPlanId: args.subscriptionPlanId,
      agreedPricePaise: args.agreedPricePaise,
      notes: args.notes ?? null,
      status: to,
      organizationId: args.organizationId,
      appointmentId: appointment.id,
      // The pay window closes 15 minutes before the session at the latest.
      ...(args.paid ? { paymentDueAt: payWindowEnd(now, args.startsAt) } : {}),
    },
    // The include is read back in one joined statement, not one per relation.
    relationLoadStrategy: "join",
    include: TRIAL_CREATED_INCLUDE,
  });

  await appendCreationHistory(tx, "TRIAL", created.id, to, {
    appointmentId: appointment.id,
    actorUserId: args.consulteeUserId,
    organizationId: args.organizationId,
    reason: "trial requested",
  });

  return { ...created, appointmentId: appointment.id };
}

interface TrialPick {
  consultantProfileId: string;
  buyerConsultantProfileId: string | null | undefined;
  startsAt: Date;
  endsAt: Date;
}

/** The window on the host's calendar and, for a buyer who is an expert too, on their own. */
function trialPickEntries(pick: TrialPick): SlotBatchEntry[] {
  return [pick.consultantProfileId, pick.buyerConsultantProfileId]
    .filter((id): id is string => !!id)
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((consultantProfileId) => ({
      consultantProfileId,
      startsAt: pick.startsAt,
      endsAt: pick.endsAt,
    }));
}

/**
 * The first statement of a transaction that writes a trial's time: the
 * database's try-locks over the atoms `lockTrialPick` took. A held atom is the
 * door's slot-taken refusal unless the caller passes its own.
 */
export async function lockTrialPickInTx(
  tx: Pick<Tx, "$queryRaw">,
  pick: TrialPick,
  refusal: () => Error = () => new TrialTimeRefusedError("SLOT_TAKEN"),
): Promise<void> {
  await lockHostTimeInTx(tx, trialPickEntries(pick), refusal);
}

/**
 * The consultee lock, then the slot atoms over the host's calendar and, for a
 * buyer who is an expert too, their own: checkout's global order (taken after
 * the expert's request-cap lock). Resolves to the release, which frees them in
 * reverse. Throws the lock module's typed errors; nothing is held on a throw.
 */
export async function lockTrialPick(
  args: TrialPick & { consulteeUserId: string },
): Promise<() => Promise<void>> {
  const consulteeLock = await lockConsulteeBooking(args.consulteeUserId);
  let slots: SlotBatchGrant;
  try {
    slots = await lockSlotBatch(trialPickEntries(args));
  } catch (error) {
    await unlockConsulteeBooking(consulteeLock);
    throw error;
  }
  return async () => {
    await unlockSlotBooking(slots);
    await unlockConsulteeBooking(consulteeLock);
  };
}
