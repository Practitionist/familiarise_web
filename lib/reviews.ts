import prisma, { type Tx } from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import type {
  AppointmentsType,
  ReviewTrack,
  OccurrenceCompletionStatus,
} from "@prisma/client";

/**
 * #705 / #1300 — the publication gates are code constants, not columns and not
 * env vars: one platform-wide trust policy that has to be byte-identical in the
 * explore sort, the profile page and any structured-data `aggregateRating`. A
 * per-consultant column would invite tuning, which is exactly the gaming vector
 * the threshold exists to close, and an env var makes preview and production
 * disagree about a number users can see. Same call as MIN_COHORT in the org
 * feedback summary.
 *
 * Five rather than Practo's ten: at launch a threshold of ten would leave
 * almost every consultant with no visible score at all, and an honest "not
 * enough yet" only helps if some consultants clear it.
 */

/**
 * The 1:1 gate. 1:1 counts distinct CLIENTS: a 1:1 review row is one per (consultant, client)
 * pair, so "five" means five different people — under a per-purchase model it
 * could have meant five bookings from two people.
 */
export const MIN_RATED_CLIENTS_ONE_TO_ONE = 5;

/**
 * Group counts distinct EVENTS, not attendees. Two hundred people at one webinar
 * are one data point about the consultant, and five webinars is the same
 * evidentiary bar as five clients.
 */
export const MIN_RATED_EVENTS_GROUP = 5;

/**
 * ...and an event only becomes a data point once enough of its attendees
 * answered. Without this a 200-seat webinar with two replies buys a published
 * score off two opinions. Peloton deleted its class rating outright because the
 * distribution had no variance; a response floor is the cheaper version of
 * caring about that.
 */
export const MIN_GROUP_RESPONSES_PER_EVENT = 5;

/**
 * Which reputation a booking's review belongs to.
 *
 * Keyed on the booking SHAPE, not on a stored flag: a webinar or a class is a
 * group product however few people turned up, and a consultation, subscription
 * or trial is 1:1 however long it ran.
 */
export function trackForAppointment(row: {
  webinarId: string | null;
  cohortId: string | null;
}): ReviewTrack {
  return row.webinarId || row.cohortId ? "GROUP" : "ONE_TO_ONE";
}

/**
 * Raised when the author tries to write over a review moderation has removed.
 * Accepting the edit silently would tell them it published while nothing
 * changed on the page. Both write paths raise it, so it lives here.
 */
export class ModeratedReviewError extends Error {}

/**
 * An occurrence counts as held when it completed, or when it is UNVERIFIED —
 * that status means "past, with no Meeting recorded", which is what an
 * offline session looks like. Excluding it would silently deny a review to
 * everyone whose session did not run through the video stack.
 */
export function heldOccurrence(userId: string) {
  return {
    deletedAt: null,
    // A call that was called off never happened, whoever joined the room
    // beforehand. Both callers already claim this exclusion in their comments;
    // only the UNVERIFIED arm actually pinned a status, so an attended slot
    // later stamped CANCELLED stayed rateable through the API.
    completionStatus: {
      notIn: ["CANCELLED", "RESCHEDULED"] as OccurrenceCompletionStatus[],
    },
    // Not "the call happened" — "YOU were at the call". A COMPLETED slot the
    // user never joined used to qualify, so a no-show could rate a session they
    // did not attend and it fed the consultant's quality signal. Two ways in:
    OR: [
      // 1. You were demonstrably there, AND the call is over. This cannot key
      //    on `completionStatus` alone: that only flips when the
      //    call.session_ended webhook lands, which fires after the LAST
      //    participant leaves plus an inactivity timeout — so a post-call
      //    prompt keyed on it shows nothing to whoever leaves first.
      //
      //    The attendance row alone is not enough either: it is written when a
      //    participant JOINS, so on its own this qualified a slot that was
      //    still running, and a consultee could rate mid-call — moving the
      //    consultant's public ranking before the session had finished, since
      //    the review route recomputes the published score immediately.
      //    Testing `endedAt` rather than the clock keeps the property above:
      //    the host closing the room releases everyone, including whoever left
      //    first. The booked window is the fallback when nothing closed it.
      //
      //    #1554 — attendance is keyed to the call itself
      //    (MeetingAttendance.appointmentOccurrenceId), so no Meeting join.
      {
        AND: [
          { attendances: { some: { userId } } },
          {
            OR: [
              { meeting: { endedAt: { not: null } } },
              { endsAt: { lt: new Date() } },
            ],
          },
        ],
      },
      // 2. Nobody COULD have recorded it. UNVERIFIED means "past, with no
      //    Meeting", which is what an offline session looks like —
      //    excluding it would deny feedback to everyone who met in person.
      {
        completionStatus: "UNVERIFIED" as OccurrenceCompletionStatus,
      },
    ],
  };
}

/** A review row, reduced to what the score needs. */
interface ScorableReview {
  rating: number;
  track: ReviewTrack | null;
  ratingUnitId: string | null;
}

/** One track's answer. */
interface TrackScore {
  /** The plain arithmetic mean of the data points; NULL below the publication gate. */
  published: number | null;
  /** Data points: distinct clients for 1:1, qualifying events for group. Always shown beside the score. */
  count: number;
}

/** Round to two decimals, the precision every surface renders. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * #1566 — a published score is the plain mean of its track's data points once the
 * gate clears, and nothing before. No prior, no decay: at this scale a Bayesian
 * average manufactures "why is my 5.0 shown as 4.65" tickets, and the count printed
 * beside every score is the disclosure that lets thin samples sort honestly.
 * ADR 29 names the trigger for a disclosed prior; see docs/reviews/02-two-track-scoring.md.
 */
function scoreTrack(points: number[], minCount: number): TrackScore {
  if (points.length < minCount)
    return { published: null, count: points.length };
  const mean = points.reduce((sum, r) => sum + r, 0) / points.length;
  return { published: round2(mean), count: points.length };
}

/**
 * The 1:1 track: one review IS one data point, because a 1:1 row is one per
 * client. No bucket key needed — that is the simplification the split buys.
 */
function oneToOnePoints(rows: ScorableReview[]): number[] {
  return rows.filter((r) => r.track === "ONE_TO_ONE").map((r) => r.rating);
}

/**
 * The group track: one EVENT is one data point, and only once enough of its
 * attendees answered.
 *
 * Weighting per attendee systematically punishes whoever fills the room;
 * weighting per event lets a three-person class outvote a two-hundred-person
 * one. Within the group track, one-event-one-vote plus a response floor is the
 * honest compromise: the floor is what stops a 200-seat webinar with two replies
 * counting at all.
 */
function groupPoints(rows: ScorableReview[]): number[] {
  const byEvent = new Map<string, number[]>();
  for (const r of rows) {
    // A GROUP review with no event key cannot be attributed to an event, so it
    // cannot be one data point about one. Legacy rows land here and are skipped
    // rather than guessed at.
    if (r.track !== "GROUP" || !r.ratingUnitId) continue;
    const acc = byEvent.get(r.ratingUnitId);
    if (acc) acc.push(r.rating);
    else byEvent.set(r.ratingUnitId, [r.rating]);
  }
  return [...byEvent.values()]
    .filter((ratings) => ratings.length >= MIN_GROUP_RESPONSES_PER_EVENT)
    .map((ratings) => ratings.reduce((a, b) => a + b, 0) / ratings.length);
}

/** The exact delegate methods scoring touches. Narrow on purpose: the dry run
 *  in lib/reviews-recompute.ts stubs `consultantProfile.update` against this
 *  type, so a new dependency here fails the build there, not an operator's
 *  pre-flight against production data. */
export type ScoringTx = {
  consultantReview: Pick<Tx["consultantReview"], "findMany">;
  consultantProfile: Pick<Tx["consultantProfile"], "update">;
};

/**
 * Recompute the denormalized rating columns on ConsultantProfile.
 *
 * TWO published scores, because a twelve-session 1:1 engagement and a 200-seat
 * webinar are different products bought by different people and averaging them
 * tells a buyer of either one nothing. Airbnb shows a listing rating beside a
 * host rating for the same reason.
 *
 * Every create/update/delete must call this inside a Serializable transaction
 * with retry — it is a read-then-write over rows two concurrent reviewers both
 * touch, so at READ COMMITTED the second write overwrites an average computed
 * without the first review and the published score stays wrong.
 */
export async function recomputeConsultantRating(
  tx: ScoringTx,
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<void> {
  // Live rows. An excluded row (#1300 ratings protection) still renders on the
  // profile, so it stays in `reviewCount`; it just leaves the arithmetic.
  const liveRows = await tx.consultantReview.findMany({
    where: { consultantProfileId, deletedAt: null },
    select: {
      rating: true,
      track: true,
      ratingUnitId: true,
      excludedFromAggregateAt: true,
    },
  });
  const rows: ScorableReview[] = liveRows.filter(
    (r) => r.excludedFromAggregateAt === null,
  );

  const one = scoreTrack(oneToOnePoints(rows), MIN_RATED_CLIENTS_ONE_TO_ONE);
  const group = scoreTrack(groupPoints(rows), MIN_RATED_EVENTS_GROUP);

  // #1554 — the blended `rating` / `publishedRating` / `ratingUnitCount` /
  // `reviewCount` columns are gone with the reset; the two tracks are the score.
  await tx.consultantProfile.update({
    where: { id: consultantProfileId },
    data: {
      publishedRatingOneToOne: one.published,
      publishedRatingGroup: group.published,
      ratedClientsOneToOne: one.count,
      ratedEventsGroup: group.count,
      ratingAggregatedAt: now,
    },
  });
}

/** One session a consultee is entitled to review. */
export interface ReviewableSession {
  appointmentId: string;
  consultantProfileId: string;
  /** Whose profile this review lands on — the card says the name, because that
   *  is who the user thinks they are reviewing. */
  consultantName: string | null;
  /** Which reputation a review of this session lands in. */
  track: ReviewTrack;
  /** The group EVENT this rating folds into. NULL on a 1:1 session, where a
   *  review is already one data point and there is nothing to collapse. */
  ratingUnitId: string | null;
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
  /**
   * Narrows the ARMS, not the page. `take: 50` applies before any caller-side
   * filter, so selecting a consultant afterwards returned nothing whenever the
   * qualifying session with them fell outside the consultee's 50 newest
   * bookings — and ProfileReviewComposer reads an empty list as "not
   * eligible", so an active client could neither post nor edit their review.
   */
  consultantProfileId?: string,
) {
  return prisma.appointment.findMany({
    where: {
      ...(appointmentId ? { id: appointmentId } : {}),
      deletedAt: null,
      OR: [
        // 1:1 arms — the wrapper IS the relationship, so ownership is the gate.
        {
          consultation: {
            requestedById: consulteeProfileId,
            ...(consultantProfileId
              ? { consultationPlan: { consultantProfileId } }
              : {}),
          },
          occurrences: { some: heldOccurrence(userId) },
        },
        {
          subscription: {
            requestedById: consulteeProfileId,
            ...(consultantProfileId
              ? { subscriptionPlan: { consultantProfileId } }
              : {}),
          },
          occurrences: { some: heldOccurrence(userId) },
        },
        {
          trial: {
            consulteeProfileId,
            status: { in: ["COMPLETED", "CONVERTED"] },
            ...(consultantProfileId ? { consultantProfileId } : {}),
          },
          occurrences: { some: heldOccurrence(userId) },
        },
        // Group arms — registration is a live AppointmentParticipant row on
        // the event's one wrapper (#1554). A paid seat is required as well, so
        // a cancelled or comped registration cannot buy a review.
        // #1580 C-P0-2 — an ACCEPTED collaborator on the plan is a consultant-
        // side party and cannot review the host as a consultee of their own event.
        {
          webinarId: { not: null },
          ...(consultantProfileId
            ? { webinar: { webinarPlan: { consultantProfileId } } }
            : {}),
          NOT: {
            webinar: {
              webinarPlan: {
                collaborators: {
                  some: { status: "ACCEPTED", consultantProfile: { userId } },
                },
              },
            },
          },
          occurrences: { some: heldOccurrence(userId) },
          participants: { some: liveParticipant(userId) },
          payment: { some: { userId, paymentStatus: "SUCCEEDED" } },
        },
        {
          cohortId: { not: null },
          ...(consultantProfileId
            ? { cohort: { cohortPlan: { consultantProfileId } } }
            : {}),
          NOT: {
            cohort: {
              cohortPlan: {
                collaborators: {
                  some: { status: "ACCEPTED", consultantProfile: { userId } },
                },
              },
            },
          },
          occurrences: { some: heldOccurrence(userId) },
          participants: { some: liveParticipant(userId) },
          payment: { some: { userId, paymentStatus: "SUCCEEDED" } },
        },
      ],
    },
    select: {
      id: true,
      appointmentType: true,
      webinarId: true,
      cohortId: true,
      organizationId: true,
      consultation: {
        select: {
          consultationPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      subscription: {
        select: {
          subscriptionPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      trial: {
        select: {
          consultantProfileId: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
      webinar: {
        select: {
          webinarPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      cohort: {
        select: {
          cohortPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      occurrences: {
        where: heldOccurrence(userId),
        select: { endsAt: true },
        orderBy: { endsAt: "desc" },
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
 * Appointment across every attendee, but a COHORT mints one per enrolment, so
 * grouping by type alone would collapse every class a consultant ever ran into
 * a single data point — worse than the imbalance being fixed.
 */
type ExistingReview = {
  id: string;
  rating: number;
  reviewDescription: string | null;
  isAnonymous: boolean;
};

/** The columns that key a review inside one (consultant, consultee) pair. */
type ReviewKey = { track: ReviewTrack | null; ratingUnitId: string | null };

function describe(
  row: AppointmentRow,
  reviewByConsultant: Map<string, (ExistingReview & ReviewKey)[]>,
): ReviewableSession | null {
  const consultantProfileId =
    row.consultation?.consultationPlan?.consultantProfileId ??
    row.subscription?.subscriptionPlan?.consultantProfileId ??
    row.trial?.consultantProfileId ??
    row.webinar?.webinarPlan?.consultantProfileId ??
    row.cohort?.cohortPlan?.consultantProfileId ??
    null;
  // Group plans may carry no consultant at all; there is nobody to review.
  if (!consultantProfileId) return null;

  const track = trackForAppointment(row);
  // Group only. A 1:1 review is one data point by construction now, so a bucket
  // key for it would be a column that always holds exactly one row.
  const ratingUnitId = row.webinarId
    ? `webinar:${row.webinarId}`
    : row.cohortId
      ? `class:${row.cohortId}`
      : null;

  return {
    appointmentId: row.id,
    consultantProfileId,
    consultantName:
      row.consultation?.consultationPlan?.consultantProfile?.user?.name ??
      row.subscription?.subscriptionPlan?.consultantProfile?.user?.name ??
      row.trial?.consultantProfile?.user?.name ??
      row.webinar?.webinarPlan?.consultantProfile?.user?.name ??
      row.cohort?.cohortPlan?.consultantProfile?.user?.name ??
      null,
    track,
    ratingUnitId,
    appointmentType: row.appointmentType,
    title:
      row.consultation?.consultationPlan?.title ??
      row.subscription?.subscriptionPlan?.title ??
      row.webinar?.webinarPlan?.title ??
      row.cohort?.cohortPlan?.title ??
      "Session",
    heldAt: row.occurrences[0]?.endsAt ?? null,
    // Keyed on the CONSULTANT and the (track, event), not this appointment: a 1:1
    // review may hang off a different booking, and a webinar's review is that
    // webinar's, not another one's (#1549).
    existingReview: pickExistingReview(
      reviewByConsultant.get(consultantProfileId) ?? [],
      track,
      ratingUnitId,
    ),
  };
}

/**
 * #1549 — which of a consultee's reviews of one consultant is "their review" of
 * this session: the row keyed exactly on (track, event), else a NULL-track legacy
 * row, which the write path then adopts into the track. The POST route applies
 * the same rule, so the composer never shows a review the write would not update.
 */
export function pickExistingReview<
  T extends { track: ReviewTrack | null; ratingUnitId: string | null },
>(rows: T[], track: ReviewTrack, ratingUnitId: string | null): T | null {
  return (
    rows.find((r) => r.track === track && r.ratingUnitId === ratingUnitId) ??
    rows.find((r) => r.track === null) ??
    null
  );
}

/** This consultee's live reviews of each of the given consultants, all tracks and events. */
async function reviewsByConsultant(
  consulteeProfileId: string,
  consultantProfileIds: string[],
): Promise<Map<string, (ExistingReview & ReviewKey)[]>> {
  if (consultantProfileIds.length === 0) return new Map();
  const rows = await prisma.consultantReview.findMany({
    where: {
      consulteeProfileId,
      deletedAt: null,
      consultantProfileId: { in: consultantProfileIds },
    },
    select: {
      id: true,
      rating: true,
      reviewDescription: true,
      isAnonymous: true,
      consultantProfileId: true,
      track: true,
      ratingUnitId: true,
    },
  });
  const out = new Map<string, (ExistingReview & ReviewKey)[]>();
  for (const { consultantProfileId, ...r } of rows) {
    const acc = out.get(consultantProfileId);
    if (acc) acc.push(r);
    else out.set(consultantProfileId, [r]);
  }
  return out;
}

/**
 * Grid E: an org-hosted engagement — the booking's own organisation's EXPERT,
 * paid through the organisation, delivering to its member — is internal, not a
 * marketplace transaction, and publishes no review. Decided at #1300 (rule 8);
 * this is the enforcement. Current membership stands in for the booking-time
 * fact until #1554 snapshots the deliverer.
 */
async function orgHostedAppointmentIds(
  rows: {
    id: string;
    organizationId: string | null;
    consultantProfileId: string;
  }[],
): Promise<Set<string>> {
  const scoped = rows.filter((r) => r.organizationId !== null);
  if (scoped.length === 0) return new Set();
  const hosted = await prisma.membership.findMany({
    where: {
      role: "EXPERT",
      status: "ACTIVE",
      payoutRecipient: "ORGANIZATION",
      OR: scoped.map((r) => ({
        organizationId: r.organizationId!,
        consultantProfileId: r.consultantProfileId,
      })),
    },
    select: { organizationId: true, consultantProfileId: true },
  });
  const key = (org: string, consultant: string) => `${org}:${consultant}`;
  const hostedKeys = new Set(
    hosted.map((m) => key(m.organizationId, m.consultantProfileId!)),
  );
  return new Set(
    scoped
      .filter((r) =>
        hostedKeys.has(key(r.organizationId!, r.consultantProfileId)),
      )
      .map((r) => r.id),
  );
}

/** Resolve a batch of appointment rows into reviewable sessions. */
async function describeAll(
  rows: AppointmentRow[],
  consulteeProfileId: string,
): Promise<ReviewableSession[]> {
  const described = rows
    .map((row) => ({ row, session: describe(row, new Map()) }))
    .filter(
      (d): d is { row: AppointmentRow; session: ReviewableSession } =>
        d.session !== null,
    );
  const hostedIds = await orgHostedAppointmentIds(
    described.map(({ row, session }) => ({
      id: row.id,
      organizationId: row.organizationId,
      consultantProfileId: session.consultantProfileId,
    })),
  );
  const eligible = described.filter(({ row }) => !hostedIds.has(row.id));
  const consultantIds = [
    ...new Set(eligible.map(({ session }) => session.consultantProfileId)),
  ];
  const byConsultant = await reviewsByConsultant(
    consulteeProfileId,
    consultantIds,
  );
  return eligible
    .map(({ row }) => describe(row, byConsultant))
    .filter((s): s is ReviewableSession => s !== null);
}

/** Every session this consultee may review, newest first. */
export async function listReviewableSessions(
  consulteeProfileId: string,
  userId: string,
  consultantProfileId?: string,
): Promise<ReviewableSession[]> {
  const rows = await loadReviewableAppointments(
    consulteeProfileId,
    userId,
    undefined,
    consultantProfileId,
  );
  return describeAll(rows, consulteeProfileId);
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
  return (await describeAll(rows, consulteeProfileId))[0] ?? null;
}
