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
import { recordParticipants } from "@/lib/booking/participants";
import {
  appendCreationHistory,
  transitionTrial,
} from "@/lib/booking/transitions";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
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
  startsAt: Date;
  endsAt: Date;
  now?: Date;
}

/**
 * Writes the trial, its appointment and its one session on the caller's
 * transaction, after `trialWindowRefusal` passes on the same client. The
 * caller holds the consultee lock and the slot atoms for the window.
 * Throws `TrialTimeRefusedError` when the time is not open; a concurrent
 * confirmed overlap surfaces as the exclusion violation (free trial only).
 */
export async function bookTrialInTx(tx: Tx, args: BookTrialArgs) {
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

  const created = await tx.trial.create({
    data: {
      consulteeProfileId: args.consulteeProfileId,
      consultantProfileId: args.consultantProfileId,
      subscriptionPlanId: args.subscriptionPlanId,
      notes: args.notes ?? null,
      status: TrialStatus.PENDING,
      organizationId: args.organizationId,
      appointmentId: appointment.id,
    },
    include: TRIAL_CREATED_INCLUDE,
  });

  const audit = {
    appointmentId: appointment.id,
    actorUserId: args.consulteeUserId,
    organizationId: args.organizationId,
  };
  await appendCreationHistory(tx, "TRIAL", created.id, TrialStatus.PENDING, {
    ...audit,
    reason: "trial requested",
  });
  const to = args.paid ? TrialStatus.AWAITING_PAYMENT : TrialStatus.SCHEDULED;
  await transitionTrial(tx, {
    where: { id: created.id },
    to,
    fromIn: [TrialStatus.PENDING],
    ...audit,
    reason: "buyer picked the time",
    // The pay window closes 15 minutes before the session at the latest.
    ...(args.paid
      ? {
          data: {
            paymentDueAt: payWindowEnd(args.now ?? new Date(), args.startsAt),
          },
        }
      : {}),
  });

  return { ...created, status: to, appointmentId: appointment.id };
}

/**
 * The consultee lock, then the slot atoms over the host's calendar and, for a
 * buyer who is an expert too, their own: checkout's global order (taken after
 * the expert's request-cap lock). Resolves to the release, which frees them in
 * reverse. Throws the lock module's typed errors; nothing is held on a throw.
 */
export async function lockTrialPick(args: {
  consulteeUserId: string;
  consultantProfileId: string;
  buyerConsultantProfileId: string | null | undefined;
  startsAt: Date;
  endsAt: Date;
}): Promise<() => Promise<void>> {
  const consulteeLock = await lockConsulteeBooking(args.consulteeUserId);
  let slots: SlotBatchGrant;
  try {
    slots = await lockSlotBatch(
      [args.consultantProfileId, args.buyerConsultantProfileId]
        .filter((id): id is string => !!id)
        .filter((id, i, all) => all.indexOf(id) === i)
        .map((consultantProfileId) => ({
          consultantProfileId,
          startsAt: args.startsAt,
          endsAt: args.endsAt,
        })),
    );
  } catch (error) {
    await unlockConsulteeBooking(consulteeLock);
    throw error;
  }
  return async () => {
    await unlockSlotBooking(slots);
    await unlockConsulteeBooking(consulteeLock);
  };
}
