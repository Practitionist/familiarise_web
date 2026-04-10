import { getSession } from "@/lib/auth-server";
import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type {
  OrganizationProfile,
  OrganizationMemberProfile,
  OrgMemberRole,
} from "@prisma/client";

/**
 * Requires API authentication and returns the session or an error response.
 * Use this at the start of protected API route handlers.
 */
export async function requireApiAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { session };
}

/**
 * Checks if a user has privileged access (ADMIN or STAFF role).
 *
 * Prefer the typed helpers below in API handlers — this is here for
 * places that just need a boolean branch (e.g., conditional DB queries).
 */
export function isPrivileged(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "STAFF";
}

/**
 * Strict ADMIN-only auth — for routes that mutate platform-level state
 * irreversibly (system jobs, maintenance mode, exchange rates, newsletters,
 * payouts processing). Replaces ad-hoc inline `requireAdmin()` helpers
 * scattered across `app/api/admin/**`.
 *
 * @see docs/api/auth-helpers.md for the decision matrix.
 */
export async function requireAdminAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (auth.session.user.role !== "ADMIN") {
    return {
      error: NextResponse.json(
        { error: "Forbidden — admin access required" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Strict STAFF-only auth — rejects ADMIN.
 *
 * Use for routes that are specifically staff-scoped and where an ADMIN
 * should NOT have access (e.g., "my support tickets" viewed by the staff
 * member who owns them, separated from admin's own views). This is
 * deliberately strict — most admin/staff routes want the PRIVILEGED
 * flavor below. If you're refactoring a route that previously allowed
 * both ADMIN and STAFF, use `requirePrivilegedAuth` instead.
 */
export async function requireStaffAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (auth.session.user.role !== "STAFF") {
    return {
      error: NextResponse.json(
        { error: "Forbidden — staff access required" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Privileged operator auth — ADMIN or STAFF. Use for read endpoints,
 * moderation queues, support operations, and the shared admin/staff
 * dashboard API surface. This is the most common helper for
 * `app/api/admin/**` and `app/api/staff/**` routes.
 *
 * @see docs/api/auth-helpers.md for the decision matrix.
 */
export async function requirePrivilegedAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (!isPrivileged(auth.session.user.role)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden — admin or staff access required" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Checks if the session user owns a resource based on their profile ID.
 * Returns true if the user's profile ID matches the resource owner ID.
 */
export function checkOwnership(
  session: Session,
  resourceOwnerId: string | null | undefined,
  profileType: "consultant" | "consultee" | "staff" | "admin",
): boolean {
  if (!resourceOwnerId) return false;

  const profileKeyMap = {
    consultant: "consultantProfileId",
    consultee: "consulteeProfileId",
    staff: "staffProfileId",
    admin: "adminProfileId",
  } as const;

  const profileKey = profileKeyMap[profileType];
  const userProfileId = session.user[profileKey];

  return userProfileId === resourceOwnerId;
}

/**
 * Checks if the session user is a participant in a consultation.
 * Returns true if they are either the consultant or consultee.
 */
export function isConsultationParticipant(
  session: Session,
  consultantProfileId: string | null | undefined,
  consulteeProfileId: string | null | undefined,
): boolean {
  const isConsultant = session.user.consultantProfileId === consultantProfileId;
  const isConsultee = session.user.consulteeProfileId === consulteeProfileId;
  return isConsultant || isConsultee;
}

/**
 * Creates a standardized 403 Forbidden response.
 */
export function forbiddenResponse(message = "Forbidden"): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}

/**
 * Creates a standardized 401 Unauthorized response.
 */
export function unauthorizedResponse(message = "Unauthorized"): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Creates a standardized 422 Unprocessable Entity response.
 */
export function unprocessableResponse(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 422 });
}

/**
 * Authorize access to an event (consultation/subscription/webinar/class).
 * Checks if the session user is the consultant (plan owner), consultee (requester),
 * or has a privileged role (ADMIN/STAFF).
 *
 * @returns null if authorized, or a 403 NextResponse if not
 */
export async function authorizeEventAccess(
  session: Session,
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string,
): Promise<NextResponse | null> {
  if (isPrivileged(session.user.role)) return null;

  const consultantProfileId = session.user.consultantProfileId;
  const consulteeProfileId = session.user.consulteeProfileId;

  let isAuthorized = false;

  if (eventType === "consultation") {
    const event = await prisma.consultation.findUnique({
      where: { id: eventId },
      select: {
        requestedById: true,
        consultationPlan: { select: { consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.consultationPlan.consultantProfileId ||
        consulteeProfileId === event.requestedById;
    }
  } else if (eventType === "subscription") {
    const event = await prisma.subscription.findUnique({
      where: { id: eventId },
      select: {
        requestedById: true,
        subscriptionPlan: { select: { consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.subscriptionPlan.consultantProfileId ||
        consulteeProfileId === event.requestedById;
    }
  } else if (eventType === "webinar") {
    const event = await prisma.webinar.findUnique({
      where: { id: eventId },
      select: {
        webinarPlan: { select: { id: true, consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.webinarPlan.consultantProfileId;
      if (!isAuthorized && consultantProfileId) {
        const collab = await prisma.webinarCollaborator.findFirst({
          where: {
            webinarPlanId: event.webinarPlan.id,
            consultantProfileId,
            status: "ACCEPTED",
          },
        });
        isAuthorized = !!collab;
      }
    }
  } else if (eventType === "class") {
    const event = await prisma.class.findUnique({
      where: { id: eventId },
      select: {
        classPlan: { select: { id: true, consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.classPlan.consultantProfileId;
      if (!isAuthorized && consultantProfileId) {
        const collab = await prisma.classCollaborator.findFirst({
          where: {
            classPlanId: event.classPlan.id,
            consultantProfileId,
            status: "ACCEPTED",
          },
        });
        isAuthorized = !!collab;
      }
    }
  }

  if (!isAuthorized) {
    return forbiddenResponse("You are not authorized to access this event");
  }

  return null;
}

// ============================================================================
// ORGANIZATION ACCESS HELPERS (ENTERPRISE)
// ============================================================================

/**
 * Numeric rank for OrgMemberRole — higher = more privileged.
 *
 * Used for "minimum role" checks via {@link orgRoleSatisfies}. Note that
 * ORG_SUPPORT and ORG_LEARNER deliberately sit between ORG_MANAGER and the
 * absolute floor — they have legitimate access to view their own data but
 * shouldn't be promoted above MANAGER without an explicit role change.
 */
const ORG_ROLE_RANK: Record<OrgMemberRole, number> = {
  ORG_OWNER: 100,
  ORG_ADMIN: 80,
  ORG_MANAGER: 60,
  ORG_CONSULTANT: 40,
  ORG_SUPPORT: 30,
  ORG_LEARNER: 20,
};

/**
 * Whether `actual` role meets the `minimum` role requirement.
 *
 * Examples:
 *   orgRoleSatisfies("ORG_OWNER", "ORG_ADMIN") → true
 *   orgRoleSatisfies("ORG_LEARNER", "ORG_MANAGER") → false
 *   orgRoleSatisfies("ORG_ADMIN", "ORG_ADMIN") → true (>=)
 */
export function orgRoleSatisfies(
  actual: OrgMemberRole,
  minimum: OrgMemberRole,
): boolean {
  return ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum];
}

export type OrgAccessGrant = {
  session: Session;
  member: OrganizationMemberProfile;
  org: OrganizationProfile;
};

/**
 * Require that the session user is an active member of the specified
 * organization (by `organizationId` — the BetterAuth `Organization.id`).
 *
 * Optionally require a minimum role. Roles are ranked via {@link ORG_ROLE_RANK}
 * and compared with {@link orgRoleSatisfies}.
 *
 * **Platform admins (UserRole.ADMIN) bypass org membership checks.** They can
 * manage any org for operability/support reasons. STAFF do NOT bypass — they're
 * platform-side, not org-side.
 *
 * @returns On success: { session, member, org } where `org` is the
 *          OrganizationProfile (with full enterprise fields) and `member` is
 *          the user's OrganizationMemberProfile (with the typed role enum).
 *          On failure: { error: NextResponse } with 401/403/404 as appropriate.
 *
 * @example
 *   export async function GET(_req, { params }) {
 *     const access = await requireOrgAccess((await params).orgId);
 *     if (access.error) return access.error;
 *     // access.session, access.member, access.org are all defined
 *   }
 */
export async function requireOrgAccess(
  organizationId: string,
  minimumRole?: OrgMemberRole,
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  // Resolve OrganizationProfile by the BetterAuth Organization.id
  const org = await prisma.organizationProfile.findUnique({
    where: { organizationId },
  });
  if (!org) {
    return {
      error: NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      ),
    };
  }

  if (org.status === "DEACTIVATED") {
    return {
      error: NextResponse.json(
        { error: "Organization has been deactivated" },
        { status: 403 },
      ),
    };
  }

  const userId = auth.session.user.id;

  // Platform admins bypass org membership checks for operability.
  // They get a synthesized OWNER-rank member record so callers don't have to
  // special-case admin paths.
  if (auth.session.user.role === "ADMIN") {
    const stub: OrganizationMemberProfile = {
      id: `__admin_stub_${userId}`,
      memberId: `__admin_stub_${userId}`,
      organizationProfileId: org.id,
      role: "ORG_OWNER",
      status: "ACTIVE",
      consultantProfileId: null,
      consulteeProfileId: null,
      customConsultantPayoutRate: null,
      seatAssignedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { session: auth.session, member: stub, org };
  }

  // Look up the typed member profile by joining through BetterAuth's Member.
  const member = await prisma.organizationMemberProfile.findFirst({
    where: {
      organizationProfileId: org.id,
      member: { userId },
    },
  });

  if (!member) {
    return {
      error: NextResponse.json(
        { error: "Not a member of this organization" },
        { status: 403 },
      ),
    };
  }

  if (member.status !== "ACTIVE") {
    return {
      error: NextResponse.json(
        { error: `Membership is ${member.status.toLowerCase()}` },
        { status: 403 },
      ),
    };
  }

  if (minimumRole && !orgRoleSatisfies(member.role, minimumRole)) {
    return {
      error: NextResponse.json(
        { error: `Forbidden — ${minimumRole} or higher required` },
        { status: 403 },
      ),
    };
  }

  return { session: auth.session, member, org };
}

/**
 * Convenience wrapper around {@link requireOrgAccess} for owner-only operations:
 * settings mutation, billing changes, payout account, organization deletion.
 */
export async function requireOrgOwner(
  organizationId: string,
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  return requireOrgAccess(organizationId, "ORG_OWNER");
}
