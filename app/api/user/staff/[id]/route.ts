import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { requireApiAuth, requireAdminAuth } from "@/lib/auth-helpers";

/**
 * Self-or-admin gate for this staff profile.
 *
 * Every handler in this file previously ran with NO auth of any kind:
 * `PUT` rewrote the linked User's email (an account-takeover primitive,
 * since `emailVerified` is not reset) and `DELETE` removed the profile.
 * The middleware only checks cookie presence, so nothing upstream was
 * covering it either.
 *
 * #1927 — the auth gate is in. The `emailVerified` half is fixed differently:
 * `PUT` now REFUSES an email change outright rather than resetting the flag
 * (see the comment at that branch for why a silent, unaudited address move is
 * the worse of the two fixes), and the file is no longer a `role: STAFF`
 * write site at all — onboarding goes through
 * `POST /api/admin/team/members`.
 */
async function requireSelfOrAdmin(staffProfileId: string) {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  const { role, staffProfileId: ownProfileId } = auth.session.user;
  if (role === "ADMIN" || ownProfileId === staffProfileId) {
    return { session: auth.session };
  }
  // Same 403 whether the profile is someone else's or absent — don't
  // confirm that an id exists to a caller who may not read it.
  return {
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

// GET /api/user/staff/{id} - Fetch a single staff member by profile ID
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireSelfOrAdmin(id);
    if (auth.error) return auth.error;

    const staffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
      include: {
        user: {
          include: {
            notificationPreferences: true,
            cookiePreferences: true,
          },
        },
      },
    });

    if (!staffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: staffProfile }, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get staff profile",
      },
      { status: 500 },
    );
  }
}

// POST /api/user/staff/{id} - Create a staff profile for a user
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const body = await req.json();
    const user = await prisma.user.findUnique({
      where: { id: id },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found. Cannot create staff profile." },
        { status: 404 },
      );
    }

    const createdStaffProfile = await prisma.staffProfile.create({
      data: {
        department: body.department,
        position: body.position,
        user: { connect: { id: id } },
      },
      include: {
        user: true,
      },
    });

    return NextResponse.json(createdStaffProfile, { status: 201 });
  } catch (error) {
    console.error("Error creating staff profile:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      {
        error: "An unexpected error occurred while creating the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// PATCH /api/user/staff/{id} - Update a staff profile by ID
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireSelfOrAdmin(id);
    if (auth.error) return auth.error;

    const body = await req.json();

    const existingStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
    });

    if (!existingStaffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found for updating" },
        { status: 404 },
      );
    }

    const updatedStaffProfile = await prisma.staffProfile.update({
      where: { id: id },
      data: {
        department: body.department,
        position: body.position,
      },
      include: {
        user: true,
      },
    });

    return NextResponse.json(updatedStaffProfile, { status: 200 });
  } catch (error) {
    console.error("Error updating staff profile:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      {
        error: "An unexpected error occurred while updating the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// PUT /api/user/staff/{id} - Full update of staff profile by ID
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireSelfOrAdmin(id);
    if (auth.error) return auth.error;

    const body = await req.json();

    const existingStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
      include: { user: true },
    });

    if (!existingStaffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found for updating" },
        { status: 404 },
      );
    }

    // Update staff profile
    await prisma.staffProfile.update({
      where: { id: id },
      data: {
        department: body.department,
        position: body.position,
      },
      include: {
        user: {
          include: {
            notificationPreferences: true,
            cookiePreferences: true,
          },
        },
      },
    });

    // Also update user fields if provided.
    //
    // #1927 — the email is EXCLUDED from this write, deliberately and with no
    // replacement path, because the alternative is worse than a refusal. The
    // bug this fixes is the one named in this file's own header: `PUT` used to
    // rewrite the linked User's email while leaving `emailVerified` true, so
    // any caller who passed the gate (self, or any admin) could re-point a
    // verified identity at an address they control, and BetterAuth would then
    // treat every subsequent sign-in as proven. There were two ways to close
    // it and they are not equivalent:
    //
    //   (a) write the new email AND clear `emailVerified`. Honest, and it
    //       removes the takeover. But it leaves a silent, unlogged privilege
    //       change: a staff account's address — the thing their whole
    //       invitation, their 2FA enrolment and their recovery mail are
    //       bound to — moves with no OpsActionLog row, no notification to the
    //       old address, and no re-verification the operator can see. An
    //       account-takeover primitive replaced by an account-redirect
    //       primitive is not a fix.
    //   (b) refuse the change. The operator's address is bound at onboarding
    //       (`User.email` unique) and cannot move. A genuine correction — a
    //       typo in an invitation, a name change on a personal address — is a
    //       support conversation ending in a fresh invitation, which is
    //       audited, mailed to BOTH addresses, and sets its own password.
    //
    // (b) is what this does. It is also the only one that keeps
    // `emailVerified` true meaning "this address was proven", which is the
    // invariant the rest of the auth system reads.
    if (
      body.email !== undefined &&
      body.email !== existingStaffProfile.user.email
    ) {
      return NextResponse.json(
        {
          error:
            "A staff account's email address cannot be changed here. To move an account to a new address, invite the new address and remove the old account.",
          code: "EMAIL_CHANGE_NOT_ALLOWED",
          currentEmail: existingStaffProfile.user.email,
        },
        { status: 409 },
      );
    }

    if (
      body.name ||
      body.phone ||
      body.address ||
      body.image ||
      body.timezone
    ) {
      await prisma.user.update({
        where: { id: existingStaffProfile.userId },
        data: {
          name: body.name,
          phone: body.phone,
          address: body.address,
          image: body.image,
          timezone: body.timezone,
        },
      });
    }

    // Notifications moved to the Novu-synced /api/novu/preferences panel;
    // this route only handles cookie preferences now.
    // Update cookie preferences if provided
    if (body.analytics !== undefined || body.marketing !== undefined) {
      await prisma.cookiePreference.upsert({
        where: { userId: existingStaffProfile.userId },
        update: {
          analytics: body.analytics,
          marketing: body.marketing,
        },
        create: {
          userId: existingStaffProfile.userId,
          essential: true,
          analytics: body.analytics ?? false,
          marketing: body.marketing ?? false,
        },
      });
    }

    // Fetch fresh data with all relations
    const freshStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
      include: {
        user: {
          include: {
            notificationPreferences: true,
            cookiePreferences: true,
          },
        },
      },
    });

    return NextResponse.json(freshStaffProfile, { status: 200 });
  } catch (error) {
    console.error("Error updating staff profile:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      {
        error: "An unexpected error occurred while updating the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// DELETE /api/user/staff/{id} - Delete a staff profile by ID
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const existingStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
    });

    if (!existingStaffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found for deletion" },
        { status: 404 },
      );
    }

    const deletedStaffProfile = await prisma.staffProfile.delete({
      where: { id: id },
      include: {
        user: true,
      },
    });

    return NextResponse.json(deletedStaffProfile, { status: 200 });
  } catch (error) {
    console.error("Error deleting staff profile:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      {
        error: "An unexpected error occurred while deleting the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
