import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { liveParticipant } from "@/lib/booking/participants";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { applyRateLimit, streamApiLimiter } from "@/lib/rate-limit";
import {
  isDmChannelIdEligible,
  resolveVerifiedBookingContextTitle,
} from "@/lib/stream/dm-eligibility";
import {
  bookingTagQuerySchema,
  pickSessionAnchor,
} from "@/lib/stream/booking-tag";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { isSupportStreamUser } from "@/lib/stream/support-user";
import { LEGACY_BOOKING_CONTEXT_USER_ID } from "@/lib/stream/system-users";

const collaboratorSelect = {
  where: {
    status: "ACCEPTED" as const,
    consultantProfile: { deletedAt: null },
  },
  select: {
    status: true,
    tier: true,
    consultantProfile: { select: { userId: true } },
  },
};

const planSelect = {
  title: true,
  consultantProfile: { select: { userId: true } },
};

const tagAppointmentSelect = {
  id: true,
  appointmentType: true,
  occurrences: {
    where: { ...liveOccurrenceWhere, isTentative: false },
    select: { startsAt: true, endsAt: true },
  },
  participants: {
    where: liveParticipant(),
    select: { userId: true, role: true },
  },
  consultation: {
    select: {
      status: true,
      requestedBy: { select: { userId: true } },
      consultationPlan: { select: planSelect },
    },
  },
  subscription: {
    select: {
      status: true,
      requestedBy: { select: { userId: true } },
      subscriptionPlan: { select: planSelect },
    },
  },
  webinar: {
    select: {
      status: true,
      webinarPlan: {
        select: { ...planSelect, collaborators: collaboratorSelect },
      },
    },
  },
  class: {
    select: {
      status: true,
      classPlan: {
        select: { ...planSelect, collaborators: collaboratorSelect },
      },
    },
  },
};

const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

/** The other human in a DM the caller belongs to; null unless it holds exactly the two of them. */
async function dmCounterparty(
  cid: string,
  userId: string,
): Promise<string | null> {
  const client = getStreamChatClient();
  const [channel] = await withStreamCircuitBreaker(() =>
    client.queryChannels(
      { cid: { $eq: cid }, members: { $in: [userId] } },
      {},
      { limit: 1, state: true, watch: false, presence: false },
    ),
  );
  const humans = Object.keys(channel?.state.members ?? {}).filter(
    (id) => !isSupportStreamUser(id) && id !== LEGACY_BOOKING_CONTEXT_USER_ID,
  );
  if (humans.length !== 2 || !humans.includes(userId)) return null;
  return humans.find((id) => id !== userId) ?? null;
}

/**
 * The verified booking behind a DM message tag. Answers only when both people in
 * the DM are parties to the appointment and the DM is one the pair may open.
 */
export async function GET(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const limited = await applyRateLimit(
    streamApiLimiter,
    `booking-tag:${userId}`,
  );
  if (limited) return limited;

  const parsed = bookingTagQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }
  const { appointmentId, cid } = parsed.data;

  try {
    // Independent reads: the appointment in one joined query, the DM's members from Stream.
    const [appt, counterpartyUserId] = await Promise.all([
      prisma.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: tagAppointmentSelect,
        relationLoadStrategy: "join",
      }),
      dmCounterparty(cid, userId),
    ]);
    if (!appt || !counterpartyUserId) return notFound();

    const title = resolveVerifiedBookingContextTitle(
      appt,
      userId,
      counterpartyUserId,
    );
    if (!title) return notFound();
    const channelId = cid.slice(cid.indexOf(":") + 1);
    if (!(await isDmChannelIdEligible(userId, counterpartyUserId, channelId))) {
      return notFound();
    }

    return NextResponse.json({
      title,
      kind: appt.appointmentType,
      ...pickSessionAnchor(appt.occurrences, new Date()),
    });
  } catch (error) {
    streamLogger.warn("Booking tag lookup failed", {
      userId,
      appointmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Booking details are unavailable right now." },
      { status: 503 },
    );
  }
}
