import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  buildConsultantOccupancyWhere,
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
} from "@/utils/scheduling-engine/occupancyPolicy";

/**
 * AE-2 (#784) — collaborator double-booking guard.
 *
 * A webinar/class co-host commits real time, but co-hosts are NOT slot
 * participants (only the plan owner is denormalized onto AppointmentOccurrence),
 * so neither the `occurrence_no_confirmed_overlap` exclusion constraint nor the
 * owner-scoped availability checks ever see them. Scheduling an event at a time
 * a co-host is already committed elsewhere therefore goes undetected. This guard
 * is called at the event's time-commit so a clash is rejected (→ 409).
 */

export class CollaboratorUnavailableError extends Error {
  constructor(public readonly names: string[]) {
    super(`Co-host(s) unavailable at the selected time: ${names.join(", ")}`);
    this.name = "CollaboratorUnavailableError";
  }
}

/**
 * #2010 — host schedule-conflict error when a webinar or class time-commit
 * overlaps an existing confirmed session, live tentative hold, or accepted
 * co-host commitment on the consultant's calendar.
 */
export class ConsultantScheduleConflictError extends Error {
  constructor(
    message = "That time conflicts with another confirmed session on your calendar.",
  ) {
    super(message);
    this.name = "ConsultantScheduleConflictError";
  }
}

/**
 * A co-host's existing commitments: appointments they own (across all 5
 * offering types or direct occurrence ownership), or have ACCEPTED a
 * collaboration on.
 */
function commitmentClauses(
  consultantProfileId: string,
): Prisma.AppointmentWhereInput[] {
  return [
    { consultation: { consultationPlan: { consultantProfileId } } },
    { subscription: { subscriptionPlan: { consultantProfileId } } },
    { webinar: { webinarPlan: { consultantProfileId } } },
    { class: { classPlan: { consultantProfileId } } },
    { trial: { is: { consultantProfileId } } },
    {
      webinar: {
        webinarPlan: {
          collaborators: { some: { consultantProfileId, status: "ACCEPTED" } },
        },
      },
    },
    {
      class: {
        classPlan: {
          collaborators: { some: { consultantProfileId, status: "ACCEPTED" } },
        },
      },
    },
    {
      occurrences: {
        some: {
          consultantProfileId,
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED", "VOIDED"] },
        },
      },
    },
  ];
}

/** One time range a co-host would have to be free for. */
export interface CollaboratorWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Collapse overlapping/touching windows so the overlap query carries one OR
 * term per distinct busy range rather than one per session. A class allocation
 * hands this dozens of sessions (#784 / #1206); the webinar path hands it one,
 * for which this is the identity.
 */
function mergeWindows(windows: CollaboratorWindow[]): CollaboratorWindow[] {
  const sorted = [...windows].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const merged: CollaboratorWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.startsAt.getTime() <= last.endsAt.getTime()) {
      if (w.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = w.endsAt;
      continue;
    }
    merged.push({ startsAt: w.startsAt, endsAt: w.endsAt });
  }
  return merged;
}

/**
 * Throws CollaboratorUnavailableError if any ACCEPTED co-host on the plan has a
 * live commitment overlapping ANY of `windows` — confirmed sessions and live
 * holds alike (#1319). No-op when the plan has no accepted collaborators. Run
 * inside the scheduling transaction so the read is consistent with the slot
 * write that follows.
 *
 * The multi-window form exists for CLASS, whose "time commit" is N sessions at
 * once; checking them one call at a time would be N round-trips on the common
 * no-conflict path.
 */
export async function assertCollaboratorsAvailableForWindows(
  db: Tx | typeof prisma,
  params: {
    planType: "WEBINAR" | "CLASS";
    planId: string;
    windows: CollaboratorWindow[];
    /** The event's own appointments, excluded so its slots don't self-conflict. */
    excludeAppointmentIds?: string[];
  },
): Promise<void> {
  const { planType, planId, excludeAppointmentIds } = params;
  const windows = mergeWindows(
    params.windows.filter((w) => w.endsAt.getTime() > w.startsAt.getTime()),
  );
  if (windows.length === 0) return;

  const collaborators = await db.collaborator.findMany({
    where: {
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null },
      ...(planType === "WEBINAR"
        ? { webinarPlanId: planId }
        : { classPlanId: planId }),
    },
    select: {
      consultantProfileId: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  });
  if (collaborators.length === 0) return;

  const excluded = (excludeAppointmentIds ?? []).filter(Boolean);

  // #1319 — one instant for every probe below, so the fast path and the
  // per-co-host resolution classify holds against the same clock.
  const now = new Date();

  const overlapWhere = (
    appointment: Prisma.AppointmentWhereInput,
  ): Prisma.AppointmentOccurrenceWhereInput => ({
    // Half-open overlap: existing.start < new.end AND existing.end > new.start.
    OR: windows.map((w) => ({
      startsAt: { lt: w.endsAt },
      endsAt: { gt: w.startsAt },
    })),
    deletedAt: null,
    completionStatus: { notIn: ["CANCELLED", "RESCHEDULED", "VOIDED"] },
    ...(excluded.length > 0 ? { appointmentId: { notIn: excluded } } : {}),
    appointment: {
      deletedAt: null,
      OR: buildOccupiedAppointmentFilter(),
      NOT: buildDeadHoldFilter(now),
      // Nested so the commitment clauses keep an OR of their own.
      AND: [appointment],
    },
  });

  // Fast path: one query asking whether ANY co-host clashes — no N+1 on the
  // common no-conflict scheduling path.
  const anyClash = await db.appointmentOccurrence.findFirst({
    where: overlapWhere({
      OR: collaborators.flatMap((c) =>
        commitmentClauses(c.consultantProfileId),
      ),
    }),
    select: { id: true },
  });
  if (!anyClash) return;

  // A clash exists and will block scheduling; resolve which co-host(s) for the
  // 409 message. This per-co-host probe runs only in that rare blocking case.
  const clashing: string[] = [];
  for (const c of collaborators) {
    const conflict = await db.appointmentOccurrence.findFirst({
      where: overlapWhere({ OR: commitmentClauses(c.consultantProfileId) }),
      select: { id: true },
    });
    if (conflict) {
      clashing.push(c.consultantProfile.user.name ?? c.consultantProfileId);
    }
  }

  if (clashing.length > 0) {
    throw new CollaboratorUnavailableError(clashing);
  }
}

/** Single-window form — the webinar (1 session) shape. */
export async function assertCollaboratorsAvailable(
  db: Tx | typeof prisma,
  params: {
    planType: "WEBINAR" | "CLASS";
    planId: string;
    startsAt: Date;
    endsAt: Date;
    /** The event's own appointment, excluded so its slots don't self-conflict. */
    excludeAppointmentId?: string | null;
  },
): Promise<void> {
  return assertCollaboratorsAvailableForWindows(db, {
    planType: params.planType,
    planId: params.planId,
    windows: [{ startsAt: params.startsAt, endsAt: params.endsAt }],
    excludeAppointmentIds: params.excludeAppointmentId
      ? [params.excludeAppointmentId]
      : [],
  });
}

/**
 * #2010 — Throws ConsultantScheduleConflictError if the host consultant has ANY
 * live overlapping commitment across all 5 offering types (Consultation,
 * Subscription, Webinar, Class, Trial), live tentative checkout holds, or
 * accepted co-host commitments on another plan.
 *
 * Complements the PostgreSQL `occurrence_no_confirmed_overlap` GiST exclusion
 * constraint, which only sees non-tentative occurrences whose
 * `consultantProfileId` equals this consultant (missing live tentative holds
 * and co-hosted events where another consultant is the plan owner).
 */
export async function assertConsultantAvailableForWindows(
  db: Tx | typeof prisma,
  params: {
    consultantProfileId: string;
    consultantUserId?: string;
    windows: CollaboratorWindow[];
    excludeAppointmentIds?: string[];
  },
): Promise<void> {
  if (!db.appointmentOccurrence?.findFirst) return;

  const windows = mergeWindows(
    params.windows.filter((w) => w.endsAt.getTime() > w.startsAt.getTime()),
  );
  if (windows.length === 0) return;

  const excluded = (params.excludeAppointmentIds ?? []).filter(Boolean);
  const now = new Date();

  const conflict = await db.appointmentOccurrence.findFirst({
    where: {
      OR: windows.map((w) => ({
        startsAt: { lt: w.endsAt },
        endsAt: { gt: w.startsAt },
      })),
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED", "VOIDED"] },
      ...(excluded.length > 0 ? { appointmentId: { notIn: excluded } } : {}),
      appointment: buildConsultantOccupancyWhere(
        params.consultantProfileId,
        params.consultantUserId ?? "",
        now,
      ),
    },
    select: { id: true },
  });

  if (conflict) {
    throw new ConsultantScheduleConflictError();
  }
}

export async function assertConsultantAvailable(
  db: Tx | typeof prisma,
  params: {
    consultantProfileId: string;
    consultantUserId?: string;
    startsAt: Date;
    endsAt: Date;
    excludeAppointmentId?: string | null;
  },
): Promise<void> {
  return assertConsultantAvailableForWindows(db, {
    consultantProfileId: params.consultantProfileId,
    consultantUserId: params.consultantUserId,
    windows: [{ startsAt: params.startsAt, endsAt: params.endsAt }],
    excludeAppointmentIds: params.excludeAppointmentId
      ? [params.excludeAppointmentId]
      : [],
  });
}
