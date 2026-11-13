import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";

/**
 * Shared Prisma SELECT fragments for the booking list endpoints (#997
 * Phase 0). The narrow selects replaced the old include trees, which joined
 * consultant domain/subdomain/tag M2Ms and a per-slot user M2M that no list
 * consumer reads, and over-shared user PII (email/role/phone) against the
 * #946 allowlist direction. Both list routes must stay field-identical for
 * their shared consumers, so the fragments live here rather than being
 * repeated per route.
 */

/** Public-safe user identity for list rows (#946 allowlist). */
export const PUBLIC_USER_SELECT = {
  select: { id: true, name: true, image: true },
} as const;

/** The two parties of one booking on the detail routes: public identity plus
 * the email the pay-link mail and the approval notices need. Nothing else —
 * phone/address/DOB rode along on `user: true` (#946, #1717 security pass). */
export const PARTY_USER_SELECT = {
  select: { id: true, name: true, email: true, image: true },
} as const;

/** A profile row reduced to its id and public user identity. Used for both
 * the requesting consultee and the plan's consultant profile. */
export const PROFILE_WITH_USER_SELECT = {
  select: {
    id: true,
    user: PUBLIC_USER_SELECT,
  },
} as const;

/**
 * A booking's learner as a STAFF viewer who is not a party sees it: ids and
 * public identity, without the email or the learner-only profile fields.
 */
export function publicRequester(profile: {
  id: string;
  userId: string;
  user: { id: string; name: string | null; image: string | null };
}) {
  const { id, name, image } = profile.user;
  return { id: profile.id, userId: profile.userId, user: { id, name, image } };
}

/** STAFF who are not a party read the requester in the public shape; parties and ADMIN in full. */
export function isStaffNonParty(
  role: string | null | undefined,
  isParty: boolean,
): boolean {
  return role === "STAFF" && !isParty;
}

/** A consultant profile reduced to the ids an ownership check compares. */
export const PROFILE_OWNER_SELECT = {
  select: { id: true, userId: true },
} as const;

/** The plan's consultant as one party of a booking on the detail routes. */
export const PARTY_PROFILE_SELECT = {
  select: { id: true, userId: true, user: PARTY_USER_SELECT },
} as const;

/** The plan's consultant on read-only detail payloads a learner or seat
 * holder receives: ids plus public identity, no email. */
export const HOST_PROFILE_SELECT = {
  select: { id: true, userId: true, user: PUBLIC_USER_SELECT },
} as const;

/** Appointment payload for list rows: org tag, ordered slot atoms, and the
 * payment identity fields the requests/approvals tables render. */
export const APPOINTMENT_LIST_SELECT = {
  select: {
    id: true,
    organizationId: true,
    occurrences: {
      // #1704 P1 — tombstoned rows never reach a list; RESCHEDULED rows do,
      // because they still carry the ORIGINAL startsAt and the approve gate
      // must tell them from a fresh request's tentative ones.
      where: { deletedAt: null },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        isTentative: true,
        completionStatus: true,
      },
      orderBy: { startsAt: "asc" },
    },
    payment: {
      select: {
        id: true,
        paymentStatus: true,
        amount: true,
        currency: true,
      },
    },
    // The live reschedule proposal, if the consultee named times they want.
    // Without this the consultant sees a request back in their queue with no
    // idea what was actually asked for, which is the state every reschedule
    // used to arrive in.
    rescheduleRequests: {
      // `RESCHEDULE_OPEN_STATUSES`, not a literal: this filter is duplicated
      // across six read surfaces and the literal copy is how `COUNTERED`
      // outlived the counter-round that would have produced it.
      where: {
        status: { in: RESCHEDULE_OPEN_STATUSES },
      },
      select: {
        id: true,
        status: true,
        reason: true,
        expiresAt: true,
        initiatorRole: true,
        // #1065 — only auto-allocate reads these; a consultant placing times by
        // hand on the grid would otherwise have no idea one was stated, which
        // is the same "arrives carrying less information than the booking did"
        // complaint that motivated proposals in the first place.
        preferredTimeOfDay: true,
        preferredDays: true,
        proposedTimes: {
          orderBy: { startsAt: "asc" },
          select: { startsAt: true, endsAt: true },
        },
      },
      // take:1 without an order is whichever row Postgres hands back first.
      // At most one reschedule is open per appointment (the nullable @unique,
      // which every open row claims including preference-only ones — #1065), so
      // this is unambiguous — but the ordering is what keeps it correct if that
      // ever stops being true, and costs nothing. Were a row ever allowed to
      // skip the reservation, this take:1 would silently hide a real proposal
      // behind it.
      orderBy: { createdAt: "desc" },
      take: 1,
    },
  },
} as const;
