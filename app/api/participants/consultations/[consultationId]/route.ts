import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
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
  { params }: { params: Promise<{ consultationId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consultationId } = await params;
    // Non-privileged users can only view participants for consultations they own as consultant
    const consultation = await prisma.consultation.findUnique({
      where: {
        id: consultationId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              consultationPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        consultationPlan: true,
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

    if (!consultation) {
      return new NextResponse("Consultation not found", { status: 404 });
    }

    // For consultations, participants include the consultant and consultee
    const participants = [];

    // Add the consultee who requested the consultation
    if (consultation.requestedBy.user) {
      participants.push(consultation.requestedBy.user);
    }

    // Add every seat holder on the appointment (typically the consultant)
    if (consultation.appointment) {
      const slotUsers = consultation.appointment.participants.map(
        (participant) => participant.user,
      );

      // Get unique participants by user ID (avoid duplicates)
      const uniqueUsers = Array.from(
        new Map(
          [...participants, ...slotUsers].map((user) => [user.id, user]),
        ).values(),
      );

      return NextResponse.json(
        {
          consultation,
          participants: uniqueUsers,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        consultation,
        participants,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CONSULTATION_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  if (!isPrivileged(session.user.role) && !session.user.consultantProfileId) {
    return forbiddenResponse("Only consultants can remove participants");
  }

  try {
    const { consultationId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Find the consultation
    // Non-privileged users can only modify consultations they own as consultant
    const consultation = await prisma.consultation.findUnique({
      where: {
        id: consultationId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              consultationPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      select: { appointment: { select: { id: true } } },
    });

    if (!consultation) {
      return new NextResponse("Consultation not found", { status: 404 });
    }

    // #1554 — the seat is released by status; the participant row is history.
    if (consultation.appointment) {
      await releaseParticipant(prisma, {
        appointmentId: consultation.appointment.id,
        userId,
      });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CONSULTATION_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
