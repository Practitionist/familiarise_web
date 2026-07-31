import type { RescheduleRequestStatus } from "@prisma/client";

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

/** A profile row reduced to its id and public user identity. Used for both
 * the requesting consultee and the plan's consultant profile. */
export const PROFILE_WITH_USER_SELECT = {
  select: {
    id: true,
    user: PUBLIC_USER_SELECT,
  },
} as const;

/** Appointment payload for list rows: org tag, ordered slot atoms, and the
 * payment identity fields the requests/approvals tables render. */
export const APPOINTMENT_LIST_SELECT = {
  select: {
    id: true,
    organizationId: true,
    slotsOfAppointment: {
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        isTentative: true,
        // A RESCHEDULED slot still carries its ORIGINAL startsAt, so the
        // requests table must be able to tell those rows apart from a fresh
        // request's tentative ones before offering "Use Requested Times".
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
      // Typed rather than inferred: the file's `as const` would otherwise make
      // this a readonly tuple, which Prisma's Exact<> rejects.
      where: {
        status: { in: ["PENDING_REVIEW", "COUNTERED"] as RescheduleRequestStatus[] },
      },
      select: {
        id: true,
        status: true,
        reason: true,
        round: true,
        expiresAt: true,
        initiatorRole: true,
        proposedSlots: {
          orderBy: { startsAt: "asc" },
          select: { startsAt: true, endsAt: true },
        },
      },
      take: 1,
    },
  },
} as const;
