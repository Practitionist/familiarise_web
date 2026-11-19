import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "@/lib/prisma";
import { getUserDetails } from "@/lib/data/user-details";
import { NextRequest, NextResponse } from "next/server";
import { Gender } from "@prisma/client";
import { DateOfBirthSchema, UNDER_AGE_MESSAGE } from "@/lib/compliance/age";

import { getSession } from "@/lib/auth-server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { revokeAllUserSessions } from "@/lib/auth/session-revoke";
import {
  detachSessionAccessLogs,
  stampSessionEnds,
  type EndedSessions,
} from "@/lib/auth/session-access-log";
import { persistProfessionalBackground } from "@/utils/onboarding-server";
import {
  derivePseudonym,
  eraseStreamPrincipalFootprint,
  hasMoneyInFlight,
  moneyInFlightForUser,
  scrubUser,
  soleOwnerOrganizationsForUser,
} from "@/lib/compliance/erasure/scrub-user";
import { checkActiveAppointments } from "@/app/api/user/consultants/utils/consultant-appointments";
import { deleteSubscriber } from "@/lib/novu/subscriber";
import {
  afterCollaborationEnded,
  endCollaborationsForUser,
} from "@/lib/collaborators/ending";
import { requireFreshSession } from "@/lib/auth/step-up";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { supportRetainedHistoryCount } from "@/lib/support/erasure";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import { readJsonBody } from "@/lib/api/parse";
/**
 * Convert empty strings to undefined so Prisma skips the field update.
 * For enum fields, also validates against the allowed values.
 */
function emptyToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function parseEnumOrUndefined<T extends Record<string, string>>(
  value: unknown,
  enumObj: T,
): T[keyof T] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const upper = value.toUpperCase();
  if (Object.values(enumObj).includes(upper as T[keyof T])) {
    return upper as T[keyof T];
  }
  return undefined;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The owner edits their own profile; an ADMIN edits another's only on a fresh session. */
async function authorizeProfileEdit(id: string) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return { error: auth.error };
  const { session } = auth;
  if (session.user.id !== id && session.user.role !== "ADMIN") {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const adminEdit = session.user.id !== id;
  const stale = adminEdit ? requireFreshSession(session) : null;
  if (stale) return { error: stale };
  return { error: null, session, adminEdit };
}

/** An admin's edit of another user's profile writes one operator audit row. */
function recordAdminProfileEdit(
  tx: Tx,
  actorUserId: string,
  targetUserId: string,
  change: { action: string; fields: string[] },
) {
  return recordOpsAction(tx, {
    actorUserId,
    actorRole: "ADMIN",
    surface: "users.moderate",
    action: change.action,
    targetKind: "User",
    targetId: targetUserId,
    reason: "Admin edit of another user's profile",
    after: { fields: change.fields },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session || (session.user.id !== id && session.user.role !== "ADMIN")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserDetails(id);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ data: user }, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while fetching the user",
      },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const auth = await authorizeProfileEdit(id);
    if (auth.error) return auth.error;
    const { session, adminEdit } = auth;

    // Never `role` or `email`, whatever the body says. A self-edit that set
    // role made any consultee an ADMIN, and an email rewrite skips
    // verification (an account-takeover primitive). Operator roles change on
    // the Team page; onboarding sets the role in its completion transaction.
    const read = await readJsonBody(req);
    if (read.error) return read.error;
    const body = read.body;
    const {
      name,
      image,
      phone,
      address,
      currentTimezone,
      // New user fields
      dateOfBirth,
      gender,
      city,
      country,
      linkedinUrl,
      bio,
    } = body;

    // Validate bio length if provided
    if (bio && bio.length > 160) {
      return NextResponse.json(
        { error: "Bio must be 160 characters or less" },
        { status: 400 },
      );
    }

    // The 18+ rule applies to every write of a date of birth.
    const parsedDateOfBirth = dateOfBirth
      ? DateOfBirthSchema.safeParse(dateOfBirth)
      : null;
    if (parsedDateOfBirth && !parsedDateOfBirth.success) {
      return NextResponse.json(
        {
          error:
            parsedDateOfBirth.error.issues[0]?.message ?? UNDER_AGE_MESSAGE,
          code: "VALIDATION",
          field: "dateOfBirth",
        },
        { status: 400 },
      );
    }

    const data = {
      name: emptyToUndefined(name),
      image: emptyToUndefined(image),
      phone: emptyToUndefined(phone),
      address: emptyToUndefined(address),
      timezone: emptyToUndefined(currentTimezone),
      dateOfBirth: parsedDateOfBirth?.data,
      gender: parseEnumOrUndefined(gender, Gender),
      city: emptyToUndefined(city),
      country: emptyToUndefined(country),
      linkedinUrl: emptyToUndefined(linkedinUrl),
      bio: emptyToUndefined(bio),
    };
    const select = {
      id: true,
      name: true,
      email: true,
      image: true,
      phone: true,
      address: true,
      onboardingCompleted: true,
      role: true,
      timezone: true,
      dateOfBirth: true,
      gender: true,
      city: true,
      country: true,
      linkedinUrl: true,
      bio: true,
    } as const;
    // Onboarding completes only through its own transaction, never a self-edit.
    const updatedUser = adminEdit
      ? await prisma.$transaction(async (tx) => {
          await recordAdminProfileEdit(tx, session.user.id, id, {
            action: "user.profile.update",
            fields: Object.entries(data)
              .filter(([, value]) => value !== undefined)
              .map(([key]) => key),
          });
          return tx.user.update({ where: { id }, data, select });
        })
      : await prisma.user.update({ where: { id }, data, select });

    if (name !== undefined || image !== undefined) {
      const expert = await prisma.consultantProfile.findUnique({
        where: { userId: id },
        select: { id: true },
      });
      if (expert) purgeExpertSurfaces(expert.id);
    }

    return NextResponse.json({ data: updatedUser }, { status: 200 });
  } catch (error) {
    console.error("Error updating user:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating the user" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const auth = await authorizeProfileEdit(id);
    if (auth.error) return auth.error;
    const { session, adminEdit } = auth;

    const read = await readJsonBody(req);
    if (read.error) return read.error;
    const body = read.body;

    await prisma.$transaction(async (tx) => {
      if (adminEdit) {
        await recordAdminProfileEdit(tx, session.user.id, id, {
          action: "user.background.update",
          fields: isPlainObject(body) ? Object.keys(body) : [],
        });
      }
      await persistProfessionalBackground(id, undefined, body, tx);
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error patching user professional background:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating professional background" },
      { status: 500 },
    );
  }
}

async function checkConsulteeActiveBookingsBlock(
  consulteeProfileId: string,
): Promise<NextResponse | null> {
  const activeBookingStatuses = [
    "PENDING",
    "APPROVED",
    "APPROVED_PENDING_PAYMENT",
  ] as const;
  const [activeConsultations, activeSubscriptions, activeTrials] =
    await Promise.all([
      prisma.consultation.count({
        where: {
          requestedById: consulteeProfileId,
          status: { in: [...activeBookingStatuses] },
        },
      }),
      prisma.subscription.count({
        where: {
          requestedById: consulteeProfileId,
          status: { in: [...activeBookingStatuses] },
        },
      }),
      prisma.trial.count({
        where: {
          consulteeProfileId,
          status: { in: ["SCHEDULED", "AWAITING_PAYMENT"] },
        },
      }),
    ]);
  const totalActiveBookings =
    activeConsultations + activeSubscriptions + activeTrials;
  if (totalActiveBookings === 0) return null;

  return NextResponse.json(
    {
      error:
        "Cannot delete account while you have active or upcoming consultations, subscriptions, or trials. Please complete or cancel your active bookings first.",
      code: "ERASURE_BLOCKED_ACTIVE_BOOKINGS",
      counts: {
        activeConsultations,
        activeSubscriptions,
        activeTrials,
      },
    },
    { status: 409 },
  );
}

async function evaluateUserDeletionEligibility(id: string): Promise<{
  blockerResponse: NextResponse | null;
  hasRetainedHistory: boolean;
}> {
  const [
    soleOwnedOrgs,
    inFlight,
    paymentCount,
    referralCreditCount,
    seatCount,
    programAssignmentCount,
    erasureRequestCount,
    profile,
    consulteeProfile,
    supportHistoryCount,
  ] = await Promise.all([
    soleOwnerOrganizationsForUser(prisma, id),
    moneyInFlightForUser(prisma, id),
    prisma.payment.count({ where: { userId: id } }),
    prisma.referralCredit.count({ where: { userId: id } }),
    prisma.appointmentParticipant.count({ where: { userId: id } }),
    typeof prisma.programAssignment?.count === "function"
      ? prisma.programAssignment.count({
          where: { membership: { userId: id } },
        })
      : Promise.resolve(0),
    typeof prisma.erasureRequest?.count === "function"
      ? prisma.erasureRequest.count({ where: { userId: id } })
      : Promise.resolve(0),
    prisma.consultantProfile.findFirst({
      where: { userId: id },
      select: {
        id: true,
        _count: {
          select: {
            earnings: true,
            organizationEarnings: true,
            payouts: true,
            tdsRecords: true,
          },
        },
      },
    }),
    prisma.consulteeProfile.findFirst({
      where: { userId: id },
      select: { id: true },
    }),
    supportRetainedHistoryCount(prisma, id),
  ]);

  if (hasMoneyInFlight(inFlight)) {
    return {
      blockerResponse: NextResponse.json(
        {
          error:
            "Cannot delete account while payouts, unsettled earnings, open payment disputes, or unpaid sole-owner organization invoices are in flight. Please wait for settlement or resolve them first.",
          code: "ERASURE_BLOCKED_MONEY_IN_FLIGHT",
          counts: inFlight,
        },
        { status: 409 },
      ),
      hasRetainedHistory: false,
    };
  }

  if (soleOwnedOrgs.length > 0) {
    return {
      blockerResponse: NextResponse.json(
        {
          error:
            "Cannot delete account while you are the sole active owner of an organization. Transfer ownership or deactivate the organization first.",
          code: "ERASURE_BLOCKED_SOLE_ORG_OWNER",
          organizations: soleOwnedOrgs,
        },
        { status: 409 },
      ),
      hasRetainedHistory: false,
    };
  }

  if (profile?.id) {
    const activeAppointments = await checkActiveAppointments(
      profile.id,
      prisma,
      "removal",
    );
    if (activeAppointments.hasActive) {
      return {
        blockerResponse: NextResponse.json(
          {
            error: `Cannot delete account while you have active or upcoming appointments (${activeAppointments.details ?? `${activeAppointments.total} active`}). Please complete or cancel them first.`,
            code: "ERASURE_BLOCKED_ACTIVE_APPOINTMENTS",
            breakdown: activeAppointments.breakdown,
          },
          { status: 409 },
        ),
        hasRetainedHistory: false,
      };
    }
  }

  if (consulteeProfile?.id) {
    const bookingBlocker = await checkConsulteeActiveBookingsBlock(
      consulteeProfile.id,
    );
    if (bookingBlocker) {
      return { blockerResponse: bookingBlocker, hasRetainedHistory: false };
    }
  }

  const consultantMoneyCount = profile
    ? profile._count.earnings +
      (profile._count.organizationEarnings ?? 0) +
      profile._count.payouts +
      profile._count.tdsRecords
    : 0;
  return {
    blockerResponse: null,
    hasRetainedHistory:
      paymentCount +
        referralCreditCount +
        seatCount +
        programAssignmentCount +
        erasureRequestCount +
        consultantMoneyCount +
        supportHistoryCount >
      0,
  };
}

async function tryEraseStreamFootprint(id: string): Promise<boolean> {
  try {
    await eraseStreamPrincipalFootprint(id);
    return true;
  } catch (streamError) {
    Sentry.captureException(
      streamError instanceof Error
        ? streamError
        : new Error(String(streamError)),
      { tags: { subsystem: "stream", op: "user.delete" } },
    );
    return false;
  }
}

async function executeRetainedUserScrub(id: string): Promise<NextResponse> {
  const activeRequest = prisma.erasureRequest?.findFirst
    ? await prisma.erasureRequest.findFirst({
        where: { userId: id, status: { in: ["PENDING", "IN_PROGRESS"] } },
        select: { id: true },
      })
    : null;
  const scrubResult = await scrubUser(prisma, id);
  const streamErased = activeRequest?.id
    ? !scrubResult.vendorFailures.some((f) => f.startsWith("stream:"))
    : await tryEraseStreamFootprint(id);
  const novuErased = await deleteSubscriber(id);
  return NextResponse.json({
    message:
      "Account erased (PII scrubbed; financial history retained per statutory retention)",
    softDeleted: true,
    novuCleanup: novuErased ? "done" : "pending",
    streamCleanup: streamErased ? "done" : "pending",
  });
}

async function executeUserHardDeleteOrFallbackScrub(
  id: string,
): Promise<NextResponse> {
  const streamErased = await tryEraseStreamFootprint(id);
  if (!streamErased) {
    await scrubUser(prisma, id);
    const novuErased = await deleteSubscriber(id);
    return NextResponse.json({
      message:
        "Account erased (PII scrubbed; Stream cleanup pending retry before permanent removal)",
      softDeleted: true,
      novuCleanup: novuErased ? "done" : "pending",
      streamCleanup: "pending",
    });
  }

  const subjectPseudonymousId = derivePseudonym(id);
  const now = new Date();
  const auditRetainedUntil = new Date(now);
  auditRetainedUntil.setUTCFullYear(auditRetainedUntil.getUTCFullYear() + 7);
  let endedSessions: EndedSessions[] = [];
  const removedCollaborations = await prisma.$transaction(async (tx) => {
    const removed = await endCollaborationsForUser(tx, id, {
      endedByUserId: null,
    });
    await tx.consentArtifact.updateMany({
      where: { userId: id },
      data: {
        userId: null,
        subjectPseudonymousId,
        withdrawnAt: now,
        auditRetainedUntil,
      },
    });
    endedSessions = (await revokeAllUserSessions(tx, id)).ended;
    // The user row goes first: a concurrent end stamp then waits on it and links nothing.
    await tx.user.delete({ where: { id } });
    await detachSessionAccessLogs(tx, id);
    return removed;
  });
  // After commit, so a failed access-log write never fails the deletion.
  await stampSessionEnds(endedSessions, { forgetUser: true });

  await afterCollaborationEnded(removedCollaborations, "user.delete");

  const novuErased = await deleteSubscriber(id);

  return NextResponse.json(
    {
      message: "User deleted successfully",
      novuCleanup: novuErased ? "done" : "pending",
      streamCleanup: "done",
    },
    { status: 200 },
  );
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const auth = await requireApiAuth({ expectUser: true });
    if (auth.error) return auth.error;
    const { session } = auth;
    // Self-service erasure only; operators erase through the DPDP request queue.
    if (session.user.id !== id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const stale = requireFreshSession(session);
    if (stale) return stale;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { blockerResponse, hasRetainedHistory } =
      await evaluateUserDeletionEligibility(id);
    if (blockerResponse) {
      return blockerResponse;
    }

    if (hasRetainedHistory) {
      return await executeRetainedUserScrub(id);
    }

    return await executeUserHardDeleteOrFallbackScrub(id);
  } catch (error) {
    console.error("Error deleting user:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    return NextResponse.json(
      { error: "An error occurred while deleting the user" },
      { status: 500 },
    );
  }
}
