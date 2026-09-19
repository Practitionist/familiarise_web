import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import prisma from "@/lib/prisma";
import {
  liveParticipant,
  releaseParticipant,
} from "@/lib/booking/participants";

// Roster payload — never the full User row. The class/ and webinar/
// siblings were hardened this way in the #946 sweep; these two were
// missed and kept shipping phone, address, dateOfBirth, city and country
// on every roster poll.
const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { subscriptionId } = await params;
    // Non-privileged users can only view participants for subscriptions they own as consultant
    const subscription = await prisma.subscription.findUnique({
      where: {
        id: subscriptionId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              subscriptionPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        subscriptionPlan: true,
        appointment: {
          include: {
            participants: {
              where: liveParticipant(),
              include: { user: { select: PARTICIPANT_USER_SELECT } },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: PARTICIPANT_USER_SELECT },
          },
        },
      },
    });

    if (!subscription) {
      return new NextResponse("Subscription not found", { status: 404 });
    }

    // For subscriptions, participants include the consultant and consultee
    const participants = [];

    // Add the consultee who requested the subscription
    if (subscription.requestedBy.user) {
      participants.push(subscription.requestedBy.user);
    }

    // Add every seat holder on the wrapper (typically the consultant)
    const slotUsers =
      subscription.appointment?.participants.map(
        (participant) => participant.user,
      ) ?? [];

    // Get unique participants by user ID (avoid duplicates)
    const uniqueUsers = Array.from(
      new Map(
        [...participants, ...slotUsers].map((user) => [user.id, user]),
      ).values(),
    );

    return NextResponse.json(
      {
        subscription,
        participants: uniqueUsers,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[SUBSCRIPTION_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  if (!isPrivileged(session.user.role) && !session.user.consultantProfileId) {
    return forbiddenResponse("Only consultants can remove participants");
  }

  try {
    const { subscriptionId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Find the subscription
    // Non-privileged users can only modify subscriptions they own as consultant
    const subscription = await prisma.subscription.findUnique({
      where: {
        id: subscriptionId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              subscriptionPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      select: { id: true },
    });

    if (!subscription) {
      return new NextResponse("Subscription not found", { status: 404 });
    }

    // #1554 — the seat is released by status on every appointment of the
    // subscription; the participant rows stay as history.
    await releaseParticipant(prisma, {
      appointment: { subscriptionId: subscription.id },
      userId,
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[SUBSCRIPTION_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
