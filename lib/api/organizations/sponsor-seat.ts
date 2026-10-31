/** The user's copy for the two sponsored-seat refusals (409). */
export const SPONSOR_SEAT_MESSAGES = {
  ROLE: "Sponsored seats are for learners in your organisation",
  SELF: "You can't sponsor your own booking",
} as const;

/** What `checkAssignee` reads off a membership row. */
export const ASSIGNEE_SELECT = {
  id: true,
  status: true,
  userId: true,
  role: true,
} as const;

export type AssigneeRefusal =
  | { ok: false; code: "FOREIGN"; membershipId: string }
  | { ok: false; code: "INACTIVE"; status: string; membershipId: string }
  | { ok: false; code: "SELF"; membershipId: string }
  | { ok: false; code: "ROLE"; membershipId: string };

/**
 * A sponsored seat (and org money) goes only to an ACTIVE LEARNER of the org,
 * never to the operator assigning it. Assignment, auto-enroll and checkout's
 * org funding all decide through here; `actorMembershipId` is null at checkout.
 */
export function checkAssignee<
  M extends { id: string; status: string; role: string },
>(
  membership: M | null,
  membershipId: string,
  actorMembershipId: string | null,
): AssigneeRefusal | { ok: true; membership: M } {
  if (!membership) return { ok: false, code: "FOREIGN", membershipId };
  if (membership.id === actorMembershipId) {
    return { ok: false, code: "SELF", membershipId };
  }
  if (membership.status !== "ACTIVE") {
    return {
      ok: false,
      code: "INACTIVE",
      status: membership.status,
      membershipId,
    };
  }
  if (membership.role !== "LEARNER") {
    return { ok: false, code: "ROLE", membershipId };
  }
  return { ok: true, membership };
}
