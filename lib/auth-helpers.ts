import { lookupSession } from "@/lib/auth-session-lookup";
import { NextResponse } from "next/server";
import { reportSentryError } from "@/lib/observability/report";
import {
  setSentryIdentityFromSession,
  setSentryOrgContext,
} from "@/lib/observability/identity";
import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type {
  FundingSource,
  Organization,
  Membership,
  UserRole,
} from "@prisma/client";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";
import {
  hasAnyOrgPermission,
  type OrgSurface,
} from "@/lib/auth/org-permissions";

type ApiAuthResult =
  | { session: Session; error?: never }
  | { session?: never; error: NextResponse };

/**
 * Requires API authentication and returns the session or an error response.
 * Enforces force-fresh session lookup and the 2FA precondition for operators.
 */
export async function requireApiAuth(): Promise<ApiAuthResult> {
  const auth = await requireApiSession();
  if (auth.error) return auth;
  const refused = twoFactorPrecondition(auth.session);
  if (refused) return { error: refused };
  return auth;
}

/**
 * {@link requireApiAuth} without the operator 2FA precondition: the session
 * exists and is not banned, nothing more.
 */
export async function requireApiSession(): Promise<ApiAuthResult> {
  const lookup = await lookupSession(true);
  if (lookup.kind === "failed") {
    reportSentryError(lookup.cause, {
      subsystem: "auth",
      op: "requireApiAuth",
      expected: true,
      level: "warning",
    });
    return { error: sessionLookupFailedResponse() };
  }
  if (lookup.kind === "none") {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const { session } = lookup;
  setSentryIdentityFromSession(session);
  if (session.user.banned === true) {
    return {
      error: NextResponse.json({ error: "Account suspended" }, { status: 403 }),
    };
  }
  return { session };
}

function twoFactorPrecondition(session: Session): NextResponse | null {
  if (!isPrivileged(session.user.role)) return null;
  if (session.user.twoFactorEnabled === true) return null;
  return NextResponse.json(
    {
      error: "Set up two-factor authentication before using the back office.",
      code: "TWO_FACTOR_REQUIRED",
    },
    {
      status: 428,
      headers: { "X-Auth-Action": "enroll-2fa" },
    },
  );
}

/** Seconds a client waits before retrying a failed session lookup (#1716). */
export const SESSION_LOOKUP_RETRY_AFTER_SECONDS = 2;

export function sessionLookupFailedResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "We couldn't confirm your session just now. Try again in a moment.",
      code: "SESSION_LOOKUP_FAILED",
    },
    {
      status: 503,
      headers: { "Retry-After": String(SESSION_LOOKUP_RETRY_AFTER_SECONDS) },
    },
  );
}

/** Checks if the user has privileged access (ADMIN or STAFF role). */
export function isPrivileged(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "STAFF";
}

async function requireRoleGate(
  predicate: (role: UserRole | undefined) => boolean,
  message: string,
): Promise<ApiAuthResult> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (!predicate(auth.session.user.role as UserRole | undefined)) {
    return { error: forbiddenResponse(message) };
  }
  return { session: auth.session };
}

/** Strict ADMIN-only auth. */
export async function requireAdminAuth(): Promise<ApiAuthResult> {
  return requireRoleGate(
    (role) => role === "ADMIN",
    "Forbidden — admin access required",
  );
}

/** Privileged operator auth — ADMIN or STAFF. */
export async function requirePrivilegedAuth(): Promise<ApiAuthResult> {
  return requireRoleGate(
    (role) => isPrivileged(role),
    "Forbidden — admin or staff access required",
  );
}

/** Surface-scoped back-office auth. */
export async function requireBackofficeSurface(
  surface: BackofficeSurface,
): Promise<ApiAuthResult> {
  return requireRoleGate(
    (role) => !!role && hasBackofficePermission(role, surface),
    "Forbidden — insufficient back-office permissions",
  );
}

/** Checks if the session user owns a resource based on their profile ID. */
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

  return session.user[profileKeyMap[profileType]] === resourceOwnerId;
}

/** Creates a standardized 403 Forbidden response. */
export function forbiddenResponse(message = "Forbidden"): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}

async function hasOrgEventAccess(
  userId: string,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  const member = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: {
      status: true,
      role: true,
      organization: { select: { status: true } },
    },
  });
  if (!member || member.status !== "ACTIVE") return false;
  if (member.organization.status === "DEACTIVATED") return false;
  return hasAnyOrgPermission(member.role, [
    "catalog.manage",
    "appointments.actForOrg.reschedule",
  ]);
}

/**
 * Authorize access to an event (consultation/subscription/webinar/class).
 * Mutating methods require primary plan owner or authorized org admin; accepted
 * collaborators are permitted on read-only GET requests only.
 */
export async function authorizeEventAccess(
  session: Session,
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string,
  method: string,
): Promise<NextResponse | null> {
  if (isPrivileged(session.user.role)) return null;

  const consultantProfileId = session.user.consultantProfileId;
  const consulteeProfileId = session.user.consulteeProfileId;
  const isReadOnly = method.toUpperCase() === "GET";

  let isAuthorized = false;

  if (eventType === "consultation") {
    const event = await prisma.consultation.findUnique({
      where: { id: eventId },
      select: {
        requestedById: true,
        consultationPlan: {
          select: { consultantProfileId: true, organizationId: true },
        },
      },
    });
    if (event) {
      isAuthorized =
        (Boolean(consultantProfileId) &&
          consultantProfileId === event.consultationPlan.consultantProfileId) ||
        (Boolean(consulteeProfileId) &&
          consulteeProfileId === event.requestedById) ||
        (await hasOrgEventAccess(
          session.user.id,
          event.consultationPlan.organizationId,
        ));
    }
  } else if (eventType === "subscription") {
    const event = await prisma.subscription.findUnique({
      where: { id: eventId },
      select: {
        requestedById: true,
        subscriptionPlan: {
          select: { consultantProfileId: true, organizationId: true },
        },
      },
    });
    if (event) {
      isAuthorized =
        (Boolean(consultantProfileId) &&
          consultantProfileId === event.subscriptionPlan.consultantProfileId) ||
        (Boolean(consulteeProfileId) &&
          consulteeProfileId === event.requestedById) ||
        (await hasOrgEventAccess(
          session.user.id,
          event.subscriptionPlan.organizationId,
        ));
    }
  } else if (eventType === "webinar") {
    const event = await prisma.webinar.findUnique({
      where: { id: eventId },
      select: {
        webinarPlan: {
          select: {
            id: true,
            consultantProfileId: true,
            organizationId: true,
          },
        },
      },
    });
    if (event) {
      isAuthorized =
        (Boolean(consultantProfileId) &&
          consultantProfileId === event.webinarPlan.consultantProfileId) ||
        (await hasOrgEventAccess(
          session.user.id,
          event.webinarPlan.organizationId,
        ));
      if (!isAuthorized && isReadOnly && consultantProfileId) {
        const collab = await prisma.collaborator.findFirst({
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
        classPlan: {
          select: {
            id: true,
            consultantProfileId: true,
            organizationId: true,
          },
        },
      },
    });
    if (event) {
      isAuthorized =
        (Boolean(consultantProfileId) &&
          consultantProfileId === event.classPlan.consultantProfileId) ||
        (await hasOrgEventAccess(
          session.user.id,
          event.classPlan.organizationId,
        ));
      if (!isAuthorized && isReadOnly && consultantProfileId) {
        const collab = await prisma.collaborator.findFirst({
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

export type OrgAccessGrant = {
  session: Session;
  member: Membership;
  org: Organization;
};

export type OrgCapabilityGate = {
  permission?: OrgSurface | readonly OrgSurface[];
  canSponsor?: true;
  canHost?: true;
  fundingSource?: FundingSource;
  requireActive?: true;
  allowSuspended?: true;
};

/**
 * Require that the session user is an active Membership of the specified
 * organization, holding `opts.permission` when set, and enforce capability
 * and funding-source gates.
 */
export async function requireOrgAccess(
  organizationId: string,
  opts: OrgCapabilityGate = {},
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  const {
    permission,
    canSponsor,
    canHost,
    fundingSource,
    requireActive,
    allowSuspended,
  } = opts;

  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  let org;
  try {
    org = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        billingAccount: {
          select: { id: true, fundingSource: true },
        },
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2022"
    ) {
      reportSentryError(error, {
        subsystem: "auth",
        op: "requireOrgAccess.schema-drift",
        expected: true,
      });
      return {
        error: NextResponse.json(
          { error: "Service temporarily unavailable — retry shortly" },
          { status: 503, headers: { "Retry-After": "2" } },
        ),
      };
    }
    throw error;
  }
  if (!org) {
    return {
      error: NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      ),
    };
  }

  setSentryOrgContext({ orgId: org.id });

  if (org.status === "DEACTIVATED") {
    return {
      error: NextResponse.json(
        { error: "Organization has been deactivated" },
        { status: 403 },
      ),
    };
  }

  if (requireActive && org.status !== "ACTIVE") {
    return {
      error: NextResponse.json(
        {
          error: "ORG_NOT_VERIFIED",
          message:
            "This action is paused until a platform admin verifies your organization.",
          status: org.status,
        },
        { status: 409 },
      ),
    };
  }

  if (canSponsor === true && !org.canSponsor) {
    return {
      error: NextResponse.json(
        { error: "This organization does not sponsor bookings" },
        { status: 404 },
      ),
    };
  }
  if (canHost === true && !org.canHost) {
    return {
      error: NextResponse.json(
        { error: "This organization does not host consultants" },
        { status: 404 },
      ),
    };
  }
  if (fundingSource && org.billingAccount?.fundingSource !== fundingSource) {
    return {
      error: NextResponse.json(
        {
          error: `This endpoint requires ${fundingSource} funding`,
          currentFundingSource: org.billingAccount?.fundingSource ?? null,
        },
        { status: 404 },
      ),
    };
  }

  const userId = auth.session.user.id;

  if (auth.session.user.role === "ADMIN") {
    setSentryOrgContext({ orgId: org.id, orgRole: "ADMIN" });
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
      exclusiveEngagement: false,
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

  const suspendedAdmitted =
    allowSuspended === true && member.status === "SUSPENDED";
  if (
    (member.status !== "ACTIVE" && !suspendedAdmitted) ||
    (suspendedAdmitted && permission)
  ) {
    return {
      error: NextResponse.json(
        { error: `Membership is ${member.status.toLowerCase()}` },
        { status: 403 },
      ),
    };
  }

  if (permission && !hasAnyOrgPermission(member.role, permission)) {
    const named =
      typeof permission === "string" ? permission : permission.join(" or ");
    return {
      error: NextResponse.json(
        { error: `Forbidden — your role does not grant ${named}` },
        { status: 403 },
      ),
    };
  }

  setSentryOrgContext({
    orgId: org.id,
    orgRole: member.role,
    membershipId: member.id,
  });

  return { session: auth.session, member, org };
}

/**
 * Whether this caller may waive the consultant's own published availability
 * when allocating.
 */
export async function isEventConsultant(
  session: Session,
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string,
): Promise<boolean> {
  if (isPrivileged(session.user.role)) return true;

  const consultantProfileId = session.user.consultantProfileId;
  if (!consultantProfileId) return false;

  switch (eventType) {
    case "consultation": {
      const event = await prisma.consultation.findUnique({
        where: { id: eventId },
        select: { consultationPlan: { select: { consultantProfileId: true } } },
      });
      return (
        event?.consultationPlan.consultantProfileId === consultantProfileId
      );
    }
    case "subscription": {
      const event = await prisma.subscription.findUnique({
        where: { id: eventId },
        select: { subscriptionPlan: { select: { consultantProfileId: true } } },
      });
      return (
        event?.subscriptionPlan.consultantProfileId === consultantProfileId
      );
    }
    case "webinar": {
      const event = await prisma.webinar.findUnique({
        where: { id: eventId },
        select: { webinarPlan: { select: { consultantProfileId: true } } },
      });
      return event?.webinarPlan.consultantProfileId === consultantProfileId;
    }
    case "class": {
      const event = await prisma.class.findUnique({
        where: { id: eventId },
        select: { classPlan: { select: { consultantProfileId: true } } },
      });
      return event?.classPlan.consultantProfileId === consultantProfileId;
    }
  }
}
