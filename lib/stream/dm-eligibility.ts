/**
 * The single answer to "may these two people hold a direct message?".
 *
 * Before this module the question had three different answers living in three
 * places, and the disagreement was load-bearing rather than cosmetic:
 *
 *   `checkUserRelationship`   APPROVED, SCHEDULED (+ subscription window open)
 *   `getDmPairsForUser`       APPROVED, SCHEDULED
 *   the two search routes     APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED, COMPLETED
 *
 * Search was the widest, so it surfaced conversations for bookings the other two
 * did not consider real. Clicking one of those rows asked the client for a
 * channel that had never been created, and `channel.watch()` — which posts to
 * the same endpoint `channel.create()` does — created it on the spot, with the
 * caller as `created_by` and NOT as a member. That is the memberless
 * `dm-…`-titled thread that accepts a message and then disappears on refresh,
 * because the sidebar queries `{ members: { $in: [me] } }`.
 *
 * So the sets are unified here, at the widest of the three, and every consumer
 * imports from this file. This is a plain module, not a `"use server"` one, on
 * purpose: server-action files may only export async functions, which is why
 * `DM_ELIGIBLE_STATUSES` could not previously be shared.
 *
 * **Widening or narrowing `DM_ELIGIBLE_STATUSES` changes what the reconciler
 * deletes.** `syncUserEventChannels` treats every `dm-`/`dmo-`/`dmh-` channel
 * absent from the expected set as stale and removes the user from it. The
 * expected set is built from this constant. Narrow it and you evict people from
 * live threads; widen it without re-running the create path and you leave rows
 * the search can find but no channel backs.
 */
import prisma from "@/lib/prisma";
import {
  DM_ELIGIBLE_STATUSES,
  dmEligibleStatusFilter,
} from "@/lib/stream/dm-eligibility-statuses";

// Re-exported so consumers that need both the policy and the gate have one
// import. Consumers that need ONLY the constant should import it from
// `dm-eligibility-statuses` directly — this module pulls in Prisma.
export { DM_ELIGIBLE_STATUSES, dmEligibleStatusFilter };

type ProfileIds = {
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
};

/**
 * The (consultant, consultee) pairings these two people could form.
 *
 * Both directions, because one person may hold both profiles — a consultant who
 * also books sessions as a consultee is an ordinary account shape here, not an
 * edge case, and reading only one direction silently denied half of those pairs.
 * Returns zero, one or two pairings; zero means no relationship is even
 * expressible and the caller can skip its query entirely.
 *
 * Shared by both link checks. The two used to carry byte-identical copies of
 * this, differing only in the Prisma model they then queried, which is precisely
 * the setup where a fix lands in one copy and not the other.
 */
function buildDirections(
  a: ProfileIds,
  b: ProfileIds,
): Array<{ consultant: string; consultee: string }> {
  const directions: Array<{ consultant: string; consultee: string }> = [];
  if (a.consultantProfileId && b.consulteeProfileId) {
    directions.push({
      consultant: a.consultantProfileId,
      consultee: b.consulteeProfileId,
    });
  }
  if (b.consultantProfileId && a.consulteeProfileId) {
    directions.push({
      consultant: b.consultantProfileId,
      consultee: a.consulteeProfileId,
    });
  }
  return directions;
}

/** A consultation links the pair if either direction holds. */
async function hasConsultationLink(
  a: ProfileIds,
  b: ProfileIds,
): Promise<boolean> {
  const directions = buildDirections(a, b);
  if (directions.length === 0) return false;

  const hit = await prisma.consultation.findFirst({
    where: {
      status: dmEligibleStatusFilter(),
      OR: directions.map((d) => ({
        consultationPlan: { consultantProfileId: d.consultant },
        requestedById: d.consultee,
      })),
    },
    select: { id: true },
  });
  return !!hit;
}

/**
 * Same shape for subscriptions, minus the scheduling window.
 *
 * `schedulingPeriodEndsAt: { gte: now }` used to be part of this check. Under
 * "ever transacted" it must not be: a lapsed subscription is still a
 * relationship that happened, and gating on the window meant a thread went
 * unreachable at midnight on the renewal date — mid-conversation, with no
 * notice to either party, and with the reconciler then classifying the channel
 * stale and evicting them from their own history.
 */
async function hasSubscriptionLink(
  a: ProfileIds,
  b: ProfileIds,
): Promise<boolean> {
  const directions = buildDirections(a, b);
  if (directions.length === 0) return false;

  const hit = await prisma.subscription.findFirst({
    where: {
      status: dmEligibleStatusFilter(),
      OR: directions.map((d) => ({
        subscriptionPlan: { consultantProfileId: d.consultant },
        requestedById: d.consultee,
      })),
    },
    select: { id: true },
  });
  return !!hit;
}

/**
 * A shared slot — the group arm. This is what lets a webinar host DM an
 * attendee, and it is also why two attendees of the same webinar count as
 * linked (see the note on `canDirectMessage`).
 *
 * The soft-delete filters are not decoration. `SlotOfAppointment` and
 * `Appointment` are soft-deleted, never removed, so without them a cancelled
 * event from two years ago still reads as a live link forever.
 */
async function hasSharedSlot(
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  const slot = await prisma.slotOfAppointment.findFirst({
    where: {
      deletedAt: null,
      appointment: { deletedAt: null },
      AND: [
        { user: { some: { id: userIdA } } },
        { user: { some: { id: userIdB } } },
      ],
    },
    select: { id: true },
  });
  return !!slot;
}

/**
 * May `userIdA` and `userIdB` hold a direct message channel?
 *
 * Throws rather than returning false when the lookup itself fails. The previous
 * implementation caught everything and returned `false`, which reads as
 * "fail closed" and is the opposite in practice: as an unused advisory flag it
 * was harmless, but as the gate on channel creation a transient DB blip would
 * deny a legitimate conversation and — worse, on the reconcile path — make a
 * live channel look unexpected. A gate that cannot evaluate must say so.
 *
 * Note the group arm makes any two attendees of the same event mutually
 * eligible. That is wider than the consultee↔consultee DM block described in
 * `docs/decisions/2026-07-11-moderation-enforcement-and-peer-chat-block.md`,
 * and it is fine only because no code path offers a consultee a way to open a
 * DM: `createDirectMessageChannel` is reached from booking approval and payment
 * success, never from a user action. If a "message this person" affordance is
 * ever added to the attendee list, this arm must be split.
 */
export async function canDirectMessage(
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  if (!userIdA || !userIdB) return false;
  // Cheapest check first, and the one the screenshot was about.
  if (userIdA === userIdB) return false;

  const [a, b] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userIdA },
      select: { consultantProfileId: true, consulteeProfileId: true },
    }),
    prisma.user.findUnique({
      where: { id: userIdB },
      select: { consultantProfileId: true, consulteeProfileId: true },
    }),
  ]);
  if (!a || !b) return false;

  const results = await Promise.all([
    hasConsultationLink(a, b),
    hasSubscriptionLink(a, b),
    hasSharedSlot(userIdA, userIdB),
  ]);
  return results.some(Boolean);
}

/** Thrown when a DM is requested between two users with no booking link. */
export class DmNotPermittedError extends Error {
  constructor(userIdA: string, userIdB: string) {
    super(
      "Direct messages are only available between people who share a booking.",
    );
    this.name = "DmNotPermittedError";
    this.userIdA = userIdA;
    this.userIdB = userIdB;
  }
  readonly userIdA: string;
  readonly userIdB: string;
}

/** `canDirectMessage`, as an assertion. */
export async function assertCanDirectMessage(
  userIdA: string,
  userIdB: string,
): Promise<void> {
  if (!(await canDirectMessage(userIdA, userIdB))) {
    throw new DmNotPermittedError(userIdA, userIdB);
  }
}
