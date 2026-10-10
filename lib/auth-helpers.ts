import { lookupSession } from "@/lib/auth-session-lookup";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { sessionLookupFailedResponse } from "@/lib/auth/session-lookup-error";
import { EXPECTED_USER_HEADER } from "@/lib/auth/identity-header";
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

type ApiAuthOptions = {
  /**
   * Money and IAM writes: refuse with 409 `IDENTITY_CHANGED` when the page
   * that sent the request was rendered for a different user than the cookie
   * now carries (another tab signed in as someone else).
   */
  expectUser?: boolean;
};

/**
 * Requires API authentication and returns the session or an error response.
 * Enforces the 2FA precondition for operators.
 */
export async function requireApiAuth({
  expectUser = false,
}: ApiAuthOptions = {}): Promise<ApiAuthResult> {
  const auth = await requireApiSession();
  if (auth.error) return auth;
  const refused = twoFactorPrecondition(auth.session);
  if (refused) return { error: refused };
  if (expectUser) {
    const changed = await identityChanged(auth.session.user.id);
    if (changed) return { error: changed };
  }
  return auth;
}

/** 409 when the caller named an expected user and the session is someone else. */
async function identityChanged(
  sessionUserId: string,
): Promise<NextResponse | null> {
  const expected = (await headers()).get(EXPECTED_USER_HEADER);
  if (!expected || expected === sessionUserId) return null;
  return NextResponse.json(
    {
      error:
        "You signed in as a different account in another tab. Reload to continue.",
      code: "IDENTITY_CHANGED",
    },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * {@link requireApiAuth} without the operator 2FA precondition: the session
 * exists and is not banned, nothing more.
 */
export async function requireApiSession(): Promise<ApiAuthResult> {
  const lookup = await lookupSession();
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

/** Checks if the user has privileged access (ADMIN or STAFF role). */
export function isPrivileged(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "STAFF";
}

async function requireRoleGate(
  predicate: (role: UserRole | undefined) => boolean,
  message: string,
  { expectUser = false }: ApiAuthOptions = {},
): Promise<ApiAuthResult> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (!predicate(auth.session.user.role as UserRole | undefined)) {
    return { error: forbiddenResponse(message) };
  }
  const changed = expectUser && (await identityChanged(auth.session.user.id));
  if (changed) return { error: changed };
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
  options: ApiAuthOptions = {},
): Promise<ApiAuthResult> {
  return requireRoleGate(
    (role) => !!role && hasBackofficePermission(role, surface),
    "Forbidden — insufficient back-office permissions",
    options,
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
  if (member?.status !== "ACTIVE") return false;
  if (member.organization.status === "DEACTIVATED") return false;
  return hasAnyOrgPermission(member.role, [
    "catalog.manage",
    "appointments.actForOrg.reschedule",
  ]);
}

async function authorizeOneToOneEvent(
  userId: string,
  consultantProfileId: string | undefined,
  consulteeProfileId: string | undefined,
  eventType: "consultation" | "subscription",
  eventId: string,
): Promise<boolean> {
  const row =
    eventType === "consultation"
      ? await prisma.consultation.findUnique({
          where: { id: eventId },
          select: {
            requestedById: true,
            consultationPlan: {
              select: { consultantProfileId: true, organizationId: true },
            },
          },
        })
      : await prisma.subscription.findUnique({
          where: { id: eventId },
          select: {
            requestedById: true,
            subscriptionPlan: {
              select: { consultantProfileId: true, organizationId: true },
            },
          },
        });
  if (!row) return false;

  const plan =
    "consultationPlan" in row ? row.consultationPlan : row.subscriptionPlan;
  return (
    (Boolean(consultantProfileId) &&
      consultantProfileId === plan.consultantProfileId) ||
    (Boolean(consulteeProfileId) && consulteeProfileId === row.requestedById) ||
    (await hasOrgEventAccess(userId, plan.organizationId))
  );
}

async function authorizeGroupEvent(
  userId: string,
  consultantProfileId: string | undefined,
  isReadOnly: boolean,
  eventType: "webinar" | "class",
  eventId: string,
): Promise<boolean> {
  const row =
    eventType === "webinar"
      ? await prisma.webinar.findUnique({
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
        })
      : await prisma.class.findUnique({
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
  if (!row) return false;

  const plan = "webinarPlan" in row ? row.webinarPlan : row.classPlan;
  if (
    (Boolean(consultantProfileId) &&
      consultantProfileId === plan.consultantProfileId) ||
    (await hasOrgEventAccess(userId, plan.organizationId))
  ) {
    return true;
  }

  if (!isReadOnly || !consultantProfileId) return false;
  const collab = await prisma.collaborator.findFirst({
    where: {
      ...(eventType === "webinar"
        ? { webinarPlanId: plan.id }
        : { classPlanId: plan.id }),
      consultantProfileId,
      status: "ACCEPTED",
    },
  });
  return Boolean(collab);
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

  const isAuthorized =
    eventType === "consultation" || eventType === "subscription"
      ? await authorizeOneToOneEvent(
          session.user.id,
          session.user.consultantProfileId,
          session.user.consulteeProfileId,
          eventType,
          eventId,
        )
      : await authorizeGroupEvent(
          session.user.id,
          session.user.consultantProfileId,
          method.toUpperCase() === "GET",
          eventType,
          eventId,
        );

  return isAuthorized
    ? null
    : forbiddenResponse("You are not authorized to access this event");
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
  /** The caller only reads. A platform ADMIN passes (as an OWNER stub) only on these gates. */
  readOnly?: true;
  /** Money/IAM writes: 409 when the page was rendered for another user. */
  expectUser?: true;
};

async function fetchOrganizationWithBilling(organizationId: string) {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        billingAccount: {
          select: { id: true, fundingSource: true },
        },
      },
    });
    if (!org) {
      return {
        error: NextResponse.json(
          { error: "Organization not found" },
          { status: 404 },
        ),
      };
    }
    return { org };
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
}

function checkOrgCapabilityGates(
  org: Organization & {
    billingAccount: { id: string; fundingSource: FundingSource } | null;
  },
  opts: OrgCapabilityGate,
): NextResponse | null {
  if (org.status === "DEACTIVATED") {
    return NextResponse.json(
      { error: "Organization has been deactivated" },
      { status: 403 },
    );
  }
  if (opts.requireActive && org.status !== "ACTIVE") {
    return NextResponse.json(
      {
        error: "ORG_NOT_VERIFIED",
        message:
          "This action is paused until a platform admin verifies your organization.",
        status: org.status,
      },
      { status: 409 },
    );
  }
  if (opts.canSponsor === true && !org.canSponsor) {
    return NextResponse.json(
      { error: "This organization does not sponsor bookings" },
      { status: 404 },
    );
  }
  if (opts.canHost === true && !org.canHost) {
    return NextResponse.json(
      { error: "This organization does not host consultants" },
      { status: 404 },
    );
  }
  if (
    opts.fundingSource &&
    org.billingAccount?.fundingSource !== opts.fundingSource
  ) {
    return NextResponse.json(
      {
        error: `This endpoint requires ${opts.fundingSource} funding`,
        currentFundingSource: org.billingAccount?.fundingSource ?? null,
      },
      { status: 404 },
    );
  }
  return null;
}

function checkMemberPermissionGate(
  member: Membership | null,
  opts: OrgCapabilityGate,
): NextResponse | null {
  if (!member) {
    return NextResponse.json(
      { error: "Not a member of this organization" },
      { status: 403 },
    );
  }

  const suspendedAdmitted =
    opts.allowSuspended === true && member.status === "SUSPENDED";
  if (
    (member.status !== "ACTIVE" && !suspendedAdmitted) ||
    (suspendedAdmitted && opts.permission)
  ) {
    return NextResponse.json(
      { error: `Membership is ${member.status.toLowerCase()}` },
      { status: 403 },
    );
  }

  if (opts.permission && !hasAnyOrgPermission(member.role, opts.permission)) {
    const named =
      typeof opts.permission === "string"
        ? opts.permission
        : opts.permission.join(" or ");
    return NextResponse.json(
      { error: `Forbidden — your role does not grant ${named}` },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Require that the session user is an active Membership of the specified
 * organization, holding `opts.permission` when set, and enforce capability
 * and funding-source gates. A platform ADMIN gets a read-only OWNER stub on
 * `readOnly` gates and a 403 on every other gate; admin writes go through
 * the audited `/api/admin/*` doors.
 */
export async function requireOrgAccess(
  organizationId: string,
  opts: OrgCapabilityGate = {},
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  const auth = await requireApiAuth({ expectUser: opts.expectUser });
  if (auth.error) return { error: auth.error };

  const orgLookup = await fetchOrganizationWithBilling(organizationId);
  if (orgLookup.error) return { error: orgLookup.error };
  const { org } = orgLookup;

  setSentryOrgContext({ orgId: org.id });

  const gateError = checkOrgCapabilityGates(org, opts);
  if (gateError) return { error: gateError };

  const userId = auth.session.user.id;
  if (auth.session.user.role === "ADMIN") {
    if (opts.readOnly !== true) {
      return {
        error: NextResponse.json(
          {
            error:
              "Platform admins have read-only access to organizations — act through the back office.",
            code: "ADMIN_READ_ONLY",
          },
          { status: 403 },
        ),
      };
    }
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

  const memberError = checkMemberPermissionGate(member, opts);
  if (memberError) return { error: memberError };

  setSentryOrgContext({
    orgId: org.id,
    orgRole: member!.role,
    membershipId: member!.id,
  });

  return { session: auth.session, member: member!, org };
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
