import { getSession } from "@/lib/auth-server";
import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type {
  Organization,
  Membership,
  MemberRole,
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
// ORGANIZATION ACCESS HELPERS — Arch 4-Modified (Issue #681)
// ============================================================================
//
// Old OrgMemberRole (ORG_OWNER, ORG_ADMIN, ...) is now MemberRole
// (OWNER, ADMIN, MANAGER, MEMBER, CONSULTANT, SUPPORT). ORG_LEARNER was
// collapsed into the generic MEMBER role.
//
// Legacy role aliases: callers that still pass "ORG_OWNER"/"ORG_ADMIN"/etc
// are coerced to the new enum via {@link normalizeLegacyRole}. This keeps
// Phase-2 incremental rewrite possible without touching every call site.
// ============================================================================

/**
 * Numeric rank for MemberRole — higher = more privileged.
 */
const ORG_ROLE_RANK: Record<MemberRole, number> = {
  OWNER: 100,
  MAINTAINER: 80,
  MANAGER: 60,
  EXPERT: 40,
  SUPPORT: 30,
  LEARNER: 20,
};

/**
 * Accepts the canonical MemberRole values, the older Checkpoint-6 draft
 * values (`ADMIN` / `MEMBER` / `CONSULTANT`), or the pre-Arch-4 legacy
 * `ORG_*` aliases, and returns the canonical MemberRole. Used at the
 * invitation-accept + onboarding boundary while we roll out the rename
 * — any persisted payload from before the rename keeps working.
 */
export function normalizeLegacyRole(
  role: MemberRole | string | null | undefined,
): MemberRole | null {
  if (!role) return null;
  if (role in ORG_ROLE_RANK) return role as MemberRole;
  const legacy: Record<string, MemberRole> = {
    // pre-Arch-4 shape
    ORG_OWNER: "OWNER",
    ORG_ADMIN: "MAINTAINER",
    ORG_MANAGER: "MANAGER",
    ORG_CONSULTANT: "EXPERT",
    ORG_LEARNER: "LEARNER",
    ORG_SUPPORT: "SUPPORT",
    // Checkpoint-6 draft shape (bare names before the EXPERT/LEARNER rename)
    ADMIN: "MAINTAINER",
    CONSULTANT: "EXPERT",
    MEMBER: "LEARNER",
  };
  return legacy[role] ?? null;
}

/**
 * Whether `actual` role meets the `minimum` role requirement.
 */
export function orgRoleSatisfies(
  actual: MemberRole,
  minimum: MemberRole,
): boolean {
  return ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum];
}

export type OrgAccessGrant = {
  session: Session;
  member: Membership;
  org: Organization;
};

/**
 * Require that the session user is an active Membership of the specified
 * organization.
 *
 * Optionally require a minimum role. Platform admins (UserRole.ADMIN)
 * bypass org membership checks and get a synthesized OWNER-rank stub.
 */
export async function requireOrgAccess(
  organizationId: string,
  minimumRole?: MemberRole | string,
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
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
  const minRole = minimumRole ? normalizeLegacyRole(minimumRole) : null;

  // Platform admins bypass org membership checks.
  if (auth.session.user.role === "ADMIN") {
    const stub: Membership = {
      id: `__admin_stub_${userId}`,
      userId,
      organizationId: org.id,
      status: "ACTIVE",
      role: "OWNER",
      departmentLabel: null,
      consulteeProfileId: null,
      consultantProfileId: null,
      payoutRecipient: "SELF",
      rateCardOverrideId: null,
      applicationNote: null,
      appliedAt: null,
      approvedAt: null,
      approvedBy: null,
      betterAuthMemberId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { session: auth.session, member: stub, org };
  }

  const member = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: org.id } },
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

  if (minRole && !orgRoleSatisfies(member.role, minRole)) {
    return {
      error: NextResponse.json(
        { error: `Forbidden — ${minRole} or higher required` },
        { status: 403 },
      ),
    };
  }

  return { session: auth.session, member, org };
}

/**
 * Convenience wrapper around {@link requireOrgAccess} for owner-only operations.
 */
export async function requireOrgOwner(
  organizationId: string,
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  return requireOrgAccess(organizationId, "OWNER");
}
