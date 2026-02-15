import { getSession } from "@/lib/auth-server";
import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";

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
 */
export function isPrivileged(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "STAFF";
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
        webinarPlan: { select: { consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.webinarPlan.consultantProfileId;
    }
  } else if (eventType === "class") {
    const event = await prisma.class.findUnique({
      where: { id: eventId },
      select: {
        classPlan: { select: { consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.classPlan.consultantProfileId;
    }
  }

  if (!isAuthorized) {
    return forbiddenResponse(
      "You are not authorized to access this event",
    );
  }

  return null;
}
