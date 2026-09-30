/**
 * `ConsultantProfile.totalMenteesHelped` — the number a consultant's public
 * profile shows as the trust stat beside their rating and their review count.
 *
 * It had exactly one writer in the whole repo: `prisma/seedFiles/1a-create-users.ts`,
 * which filled it with `experience * faker.number.int({min:5,max:20})`. Every
 * consultant's public "mentees helped" was therefore a random integer frozen at
 * seed time and never moved. This module is the writer that makes it mean
 * something.
 *
 * ## What is counted, and why that reading
 *
 * **Distinct PEOPLE the consultant has actually delivered a session to** — not
 * sessions, not bookings, not requests.
 *
 * The name says people: a mentee is a person. The design brief that specifies
 * where this renders (`prompts/ui/expert-details-page-frontend-agent.md`,
 * "Key stats row") puts it next to the rating and the review count, and the
 * review count is a count of REVIEWS — a per-engagement artifact. So a
 * sessions-based reading would put a quantity of a different kind next to its
 * neighbours: one learner in an eight-session subscription would read as eight,
 * which is a claim the consultant never made and which a competitor's
 * single-session consultations would never match.
 *
 * "Helped" also rules out the three weaker readings:
 *
 * - **Not every booking.** A consultant holding forty unpaid PENDING requests
 *   has helped nobody, and the stat sits on a page whose other two numbers
 *   (rating, review count) are both earned by delivery.
 * - **Not every session.** Same reasoning as above; also it would let a
 *   reschedule storm inflate the number.
 * - **Not every attendee.** An ACCEPTED collaborator on your own webinar is a
 *   consultant-side party and is already excluded from rating the host as a
 *   consultee of their own event (#1580 C-P0-2). The same exclusion applies
 *   here, or a consultant could raise their own public count by adding
 *   collaborators to their roster.
 *
 * A trial counts. A group-event seat counts. A person who books twice counts
 * once.
 *
 * ## What is NOT counted
 *
 * `UNVERIFIED` occurrences are excluded, deliberately, even though
 * `heldOccurrence` in `lib/reviews.ts` admits them. That helper answers "may
 * this person write a review", which needs a laxer bar than "does this person
 * count as a mentee": a review is a statement by an attendee, and an offline
 * session with no Meeting row still produces one. `endsAt < now` is the honest
 * "delivered" test and needs no such carve-out — an occurrence that has ended
 * and was not cancelled or rescheduled happened.
 *
 * ## No backfill
 *
 * The count is a stored column, so pre-reset rows hold seeded nonsense until
 * the next recompute touches them. That is the accepted posture for a pending
 * pre-MVP data reset: nothing here needs a migration, and `recomputeMenteesHelped`
 * is idempotent, so the reset can simply run it once per profile if the number
 * has to be right on day one.
 */

import type { OccurrenceCompletionStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";

/** The people each arm contributed, keyed by the arm that found them. */
export interface MenteesByArm {
  /** Users who completed a delivered consultation with this consultant. */
  oneToOne: Iterable<string>;
  /** Users who completed a delivered subscription session. */
  subscription: Iterable<string>;
  /** Users whose trial reached a delivered session. */
  trial: Iterable<string>;
  /** Users holding a live seat on a webinar this consultant hosts. */
  webinar: Iterable<string>;
  /** Users holding a live seat on a class this consultant hosts. */
  class: Iterable<string>;
}

/**
 * `|A ∪ B ∪ …|`, taken over the per-arm SETS rather than per-arm counts.
 *
 * Counts are not enough: the arms overlap (one user can be a consultation client
 * AND a class attendee), so summing over-counts and taking the max under-counts.
 * The loader therefore hands this the ids and it returns the size of the union —
 * which is the only arithmetic that matches the name "distinct people".
 *
 * Exported and pure so a test can pin the union without a database.
 */
export function countDistinctMentees(arms: MenteesByArm): number {
  return new Set<string>([
    ...arms.oneToOne,
    ...arms.subscription,
    ...arms.trial,
    ...arms.webinar,
    ...arms.class,
  ]).size;
}

/**
 * A session that was actually delivered.
 *
 * `tombstoned` and `cancelled` both mean the time went back on the calendar, so
 * neither is help given; `RESCHEDULED` means it happened somewhere else and is
 * counted under the replacement instead, so counting both would double it. The
 * `endsAt` test is what separates a past session from a booking, and it is why
 * the stat only ever moves forward within a day.
 */
function deliveredOccurrence(now: Date): {
  deletedAt: null;
  completionStatus: { notIn: OccurrenceCompletionStatus[] };
  endsAt: { lt: Date };
} {
  return {
    deletedAt: null,
    completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
    endsAt: { lt: now },
  };
}

/**
 * A live seat held by somebody who was actually served.
 *
 * `hostSideUserIds` carries the consultant and every ACCEPTED collaborator on
 * their group plans. Both must be excluded: the consultant's own roster row is
 * written with role CONSULTANT (so the role filter drops it), but an ACCEPTED
 * collaborator is written with role COLLABORATOR — indistinguishable from a
 * paying attendee by role alone. #1580 C-P0-2 already excludes them from
 * RATING the host as a consultee of their own event; the same reasoning applies
 * to a public count of people served, or a consultant could raise their own
 * figure by adding collaborators to a roster.
 */
function attendeeSeat(hostSideUserIds: string[]) {
  return {
    AND: [
      liveParticipant(),
      { role: { in: ["CONSULTEE", "COLLABORATOR"] } },
      { userId: { notIn: hostSideUserIds } },
    ],
  };
}

const ACCEPTED_COLLABORATORS = {
  where: { status: "ACCEPTED" as const },
  select: { consultantProfile: { select: { userId: true } } },
};

type MenteesDb = Pick<
  Tx,
  | "consultantProfile"
  | "consultation"
  | "subscription"
  | "trial"
  | "appointment"
>;

/**
 * Load the per-arm people sets, union them, write the column.
 *
 * Returns the number written, or `null` when there is no such profile (the same
 * "nothing to write" answer `recomputeProfileCompletion` gives with -1).
 *
 * Idempotent and safe to call from a transaction or standalone; it writes only
 * when the value would change, so a cron that recomputes every hour does not
 * write `updatedAt` on every consultant profile once an hour.
 */
export async function recomputeMenteesHelped(
  db: MenteesDb,
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      userId: true,
      totalMenteesHelped: true,
      webinarPlans: {
        select: { collaborators: ACCEPTED_COLLABORATORS },
      },
      classPlans: {
        select: { collaborators: ACCEPTED_COLLABORATORS },
      },
    },
  });
  if (!profile) return null;

  // Sequential on purpose: the collaborator exclusion is an input to every group
  // arm's WHERE, so the arms cannot be issued until this read returns. One extra
  // round trip, against a profile row and its two plan lists.
  const hostSideUserIds = [
    ...new Set([
      profile.userId,
      ...profile.webinarPlans.flatMap((p) =>
        p.collaborators.map((c) => c.consultantProfile.userId),
      ),
      ...profile.classPlans.flatMap((p) =>
        p.collaborators.map((c) => c.consultantProfile.userId),
      ),
    ]),
  ];

  const delivered = deliveredOccurrence(now);
  const seat = attendeeSeat(hostSideUserIds);

  const [consultations, subscriptions, trials, webinarSeats, classSeats] =
    await Promise.all([
      // 1:1 — the wrapper IS the relationship, so ownership is the gate.
      db.consultation.findMany({
        where: {
          consultationPlan: {
            consultantProfileId,
          },
          appointment: { occurrences: { some: delivered } },
        },
        select: { requestedBy: { select: { userId: true } } },
      }),
      db.subscription.findMany({
        where: {
          subscriptionPlan: { consultantProfileId },
          appointment: { occurrences: { some: delivered } },
        },
        select: { requestedBy: { select: { userId: true } } },
      }),
      // A trial is "helped" once a session was delivered, not once it converted;
      // conversion is a different (and rarer) fact. No status filter here — the
      // delivered occurrence is the test, and a CANCELLED trial's cancelled
      // occurrence is excluded by `delivered` on its own.
      db.trial.findMany({
        where: {
          consultantProfileId,
          appointment: { occurrences: { some: delivered } },
        },
        select: { consulteeProfile: { select: { userId: true } } },
      }),
      // Group events: a live SEAT on an event that actually delivered a session.
      // Both halves are needed. The seat is the person; the delivered occurrence
      // is the event having happened — without it, an event cancelled the day
      // before would add every registrant to the consultant's public count, and
      // the 1:1 arms above would not be counting that shape.
      db.appointment.findMany({
        where: {
          webinar: { webinarPlan: { consultantProfileId } },
          occurrences: { some: delivered },
          participants: { some: seat },
        },
        select: { participants: { where: seat, select: { userId: true } } },
      }),
      db.appointment.findMany({
        where: {
          class: { classPlan: { consultantProfileId } },
          occurrences: { some: delivered },
          participants: { some: seat },
        },
        select: { participants: { where: seat, select: { userId: true } } },
      }),
    ]);

  const total = countDistinctMentees({
    oneToOne: consultations.map((r) => r.requestedBy.userId),
    subscription: subscriptions.map((r) => r.requestedBy.userId),
    trial: trials.map((r) => r.consulteeProfile.userId),
    webinar: webinarSeats.flatMap((a) =>
      a.participants.map((p) => p.userId),
    ),
    class: classSeats.flatMap((a) => a.participants.map((p) => p.userId)),
  });

  if (total !== profile.totalMenteesHelped) {
    await db.consultantProfile.update({
      where: { id: consultantProfileId },
      data: { totalMenteesHelped: total },
    });
  }
  return total;
}
