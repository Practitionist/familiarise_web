import prisma, { type Tx } from "@/lib/prisma";
import type { AppointmentsType, SlotCompletionStatus } from "@prisma/client";

/**
 * #705 — how many distinct RATED SESSIONS a consultant needs before their score
 * is published.
 *
 * A code constant, not a column and not an env var: this is one platform-wide
 * trust policy that has to be byte-identical in the explore sort, the profile
 * page and any structured-data `aggregateRating`. A per-consultant column would
 * invite tuning, which is exactly the gaming vector the threshold exists to
 * close, and an env var makes preview and production disagree about a number
 * users can see. Same call as MIN_COHORT in the org feedback summary.
 *
 * Five rather than Practo's ten: at launch a threshold of ten would leave
 * almost every consultant with no visible score at all, and an honest "not
 * enough yet" only helps if some consultants clear it.
 */
export const MIN_RATED_UNITS_FOR_PUBLIC_SCORE = 5;

/**
 * A slot counts as held when it completed, or when it is UNVERIFIED — that
 * status means "past, with no MeetingSession recorded", which is what an
 * offline session looks like. Excluding it would silently deny a review to
 * everyone whose session did not run through the video stack.
 */
function heldSlot(userId: string) {
  return {
    deletedAt: null,
    OR: [
      {
        completionStatus: {
          in: ["COMPLETED", "UNVERIFIED"] as SlotCompletionStatus[],
        },
      },
      // Or THIS user was demonstrably in the call. `completionStatus` only
      // flips when the call.session_ended webhook lands, which fires after the
      // LAST participant leaves plus an inactivity timeout — so without this
      // the post-call prompt shows nothing to whoever leaves first, which is
      // most people. Attendance is the stronger proof anyway: it distinguishes
      // "bought a seat" from "was actually there".
      { meetingSession: { attendances: { some: { userId } } } },
    ],
  };
}

/**
 * Recompute the denormalized rating columns on ConsultantProfile.
 *
 * The average is taken over RATING UNITS, not review rows. A webinar or class
 * contributes the MEAN of its attendees' reviews as a SINGLE data point, so one
 * 200-seat event cannot dominate a consultant whose 1:1 work is the real
 * offering — and one bad event cannot tank them either. The individual review
 * cards still render; only the score is weighted.
 *
 * Rows written before `ratingUnitId` existed carry NULL. `groupBy` would lump
 * every one of them into a single bucket and collapse a consultant's whole
 * history into one point, so they are folded back in separately. That fold is
 * exact rather than an approximation: N rows averaging X contribute exactly N·X
 * to the sum.
 *
 * Every create/update/delete must call this, inside a Serializable transaction
 * with retry — it is a read-then-write over rows two concurrent reviewers both
 * touch, so at READ COMMITTED the second write overwrites an average computed
 * without the first review and the published score stays wrong.
 */
export async function recomputeConsultantRating(
  tx: Tx,
  consultantProfileId: string,
): Promise<void> {
  // #693 — soft-removed reviews (deletedAt set) must not count.
  const [units, legacy] = await Promise.all([
    tx.consultantReview.groupBy({
      by: ["ratingUnitId"],
      where: {
        consultantProfileId,
        deletedAt: null,
        ratingUnitId: { not: null },
      },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    tx.consultantReview.aggregate({
      where: { consultantProfileId, deletedAt: null, ratingUnitId: null },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  const legacyCount = legacy._count._all;
  const unitSum =
    units.reduce((sum, u) => sum + (u._avg.rating ?? 0), 0) +
    (legacy._avg.rating ?? 0) * legacyCount;
  const unitCount = units.length + legacyCount;
  const reviewCount =
    units.reduce((sum, u) => sum + u._count._all, 0) + legacyCount;

  const mean = unitCount ? Math.round((unitSum / unitCount) * 100) / 100 : 0;

  await tx.consultantProfile.update({
    where: { id: consultantProfileId },
    data: {
      rating: mean,
      ratingUnitCount: unitCount,
      reviewCount,
      publishedRating:
        unitCount >= MIN_RATED_UNITS_FOR_PUBLIC_SCORE ? mean : null,
      ratingAggregatedAt: new Date(),
    },
  });
}

/** One session a consultee is entitled to review. */
export interface ReviewableSession {
  appointmentId: string;
  consultantProfileId: string;
  /** The unit this review's rating folds into — see recomputeConsultantRating. */
  ratingUnitId: string;
  appointmentType: AppointmentsType;
  title: string;
  heldAt: Date | null;
  /** This consultee's own review of this session, if they have written one. */
  existingReview: {
    id: string;
    rating: number;
    reviewDescription: string | null;
  } | null;
}

type AppointmentRow = Awaited<
  ReturnType<typeof loadReviewableAppointments>
>[number];

function loadReviewableAppointments(
  consulteeProfileId: string,
  userId: string,
  appointmentId?: string,
) {
  return prisma.appointment.findMany({
    where: {
      ...(appointmentId ? { id: appointmentId } : {}),
      deletedAt: null,
      OR: [
        // 1:1 arms — the wrapper IS the relationship, so ownership is the gate.
        {
          consultation: { requestedById: consulteeProfileId },
          slotsOfAppointment: { some: heldSlot(userId) },
        },
        {
          subscription: { requestedById: consulteeProfileId },
          slotsOfAppointment: { some: heldSlot(userId) },
        },
        {
          trialSession: {
            consulteeProfileId,
            status: { in: ["COMPLETED", "CONVERTED"] },
          },
          slotsOfAppointment: { some: heldSlot(userId) },
        },
        // Group arms — there is no Attendee model: registration IS the m:n
        // between the user and every slot of the shared appointment. A paid
        // seat is required as well, so a cancelled or comped registration
        // cannot buy a review.
        {
          webinarId: { not: null },
          slotsOfAppointment: {
            some: { ...heldSlot(userId), user: { some: { id: userId } } },
          },
          payment: { some: { userId, paymentStatus: "SUCCEEDED" } },
        },
        {
          classId: { not: null },
          slotsOfAppointment: {
            some: { ...heldSlot(userId), user: { some: { id: userId } } },
          },
          payment: { some: { userId, paymentStatus: "SUCCEEDED" } },
        },
      ],
    },
    select: {
      id: true,
      appointmentType: true,
      webinarId: true,
      classId: true,
      consultation: {
        select: {
          consultationPlan: {
            select: { title: true, consultantProfileId: true },
          },
        },
      },
      subscription: {
        select: {
          subscriptionPlan: {
            select: { title: true, consultantProfileId: true },
          },
        },
      },
      trialSession: { select: { consultantProfileId: true } },
      webinar: {
        select: {
          webinarPlan: { select: { title: true, consultantProfileId: true } },
        },
      },
      class: {
        select: {
          classPlan: { select: { title: true, consultantProfileId: true } },
        },
      },
      slotsOfAppointment: {
        where: heldSlot(userId),
        select: { endsAt: true },
        orderBy: { endsAt: "desc" },
        take: 1,
      },
      consultantReviews: {
        where: { consulteeProfileId, deletedAt: null },
        select: { id: true, rating: true, reviewDescription: true },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: appointmentId ? 1 : 50,
  });
}

/**
 * Derive the consultant and the rating unit for one appointment.
 *
 * The unit is NOT a session-type discriminator: a WEBINAR shares one
 * Appointment across every attendee, but a CLASS mints one per enrolment, so
 * grouping by type alone would collapse every class a consultant ever ran into
 * a single data point — worse than the imbalance being fixed.
 */
function describe(row: AppointmentRow): ReviewableSession | null {
  const consultantProfileId =
    row.consultation?.consultationPlan?.consultantProfileId ??
    row.subscription?.subscriptionPlan?.consultantProfileId ??
    row.trialSession?.consultantProfileId ??
    row.webinar?.webinarPlan?.consultantProfileId ??
    row.class?.classPlan?.consultantProfileId ??
    null;
  // Group plans may carry no consultant at all; there is nobody to review.
  if (!consultantProfileId) return null;

  const ratingUnitId = row.webinarId
    ? `webinar:${row.webinarId}`
    : row.classId
      ? `class:${row.classId}`
      : `appointment:${row.id}`;

  return {
    appointmentId: row.id,
    consultantProfileId,
    ratingUnitId,
    appointmentType: row.appointmentType,
    title:
      row.consultation?.consultationPlan?.title ??
      row.subscription?.subscriptionPlan?.title ??
      row.webinar?.webinarPlan?.title ??
      row.class?.classPlan?.title ??
      "Session",
    heldAt: row.slotsOfAppointment[0]?.endsAt ?? null,
    existingReview: row.consultantReviews[0] ?? null,
  };
}

/** Every session this consultee may review, newest first. */
export async function listReviewableSessions(
  consulteeProfileId: string,
  userId: string,
): Promise<ReviewableSession[]> {
  const rows = await loadReviewableAppointments(consulteeProfileId, userId);
  return rows.map(describe).filter((s): s is ReviewableSession => s !== null);
}

/**
 * Eligibility for ONE session. Null means "not yours, not held, or not paid" —
 * the caller turns that into a 403 without saying which, since the distinction
 * would leak whether an appointment exists.
 */
export async function resolveReviewableSession(
  consulteeProfileId: string,
  userId: string,
  appointmentId: string,
): Promise<ReviewableSession | null> {
  const rows = await loadReviewableAppointments(
    consulteeProfileId,
    userId,
    appointmentId,
  );
  return rows[0] ? describe(rows[0]) : null;
}
