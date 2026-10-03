/**
 * Resolve-or-create the channel behind a search result, server-side.
 *
 * ## Why this route exists
 *
 * `ChannelSearch` used to open a result by calling
 * `client.channel(type, id).watch()` on an id the browser had computed. In
 * `stream-chat`, `watch()` posts to the channel **query** endpoint — the same
 * endpoint `create()` posts to; `channel.create()` is literally
 * `query({ created_by_id })`. So `watch()` on an id that does not exist yet
 * CREATES it. Created that way, with no `members` array, the caller becomes
 * `created_by` and is *not* a member.
 *
 * That one behaviour produced every symptom of the reported bug at once: the
 * header showed the raw `dm-…` id (channelUtils has no branch for a DM with
 * zero counterparties), it said "No members", the message sent fine, and the
 * thread vanished on reload because the sidebar queries
 * `{ members: { $in: [me] } }`. It was reported as "I can talk to myself" but
 * reproduces identically against a stranger — the phantom channel is not a
 * property of the pair, it is a property of the id not existing.
 *
 * The id did not exist because search matches `APPROVED_PENDING_PAYMENT` and
 * `COMPLETED` bookings, while channel creation only ever fired at approval and
 * payment-success. Widening `DM_ELIGIBLE_STATUSES` fixes the *set*; this route
 * fixes the *mechanism*, so a future gap cannot be papered over by the client
 * inventing a channel.
 *
 * ## Contract
 *
 * The client sends WHO or WHAT it wants to talk to, never a channel id. The id
 * is re-derived here from the caller's session plus the target. A client-
 * supplied channel id would be an authorization bypass by construction: the id
 * is a pure function of the two user ids, so anyone able to name a pair could
 * name their channel.
 *
 * Both arms are idempotent — an existing channel is returned untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { requireApiAuth } from "@/lib/auth-helpers";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import {
  canDirectMessage,
  DmNotPermittedError,
  pairBookingContexts,
} from "@/lib/stream/dm-eligibility";
import { DM_ELIGIBLE_STATUSES } from "@/lib/stream/dm-eligibility-statuses";
import { applyRateLimit, streamApiLimiter } from "@/lib/rate-limit";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import {
  addUserToEventChannel,
  isEventParticipant,
} from "@/lib/stream/event-channel-service";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dm"),
    counterpartyUserId: z.string().min(1),
    /** Funding context. Absent or null = personal. */
    organizationId: z.string().min(1).nullable().optional(),
    /** Optional appointment context to post a booking receipt card in the shared 1:1 DM. */
    contextAppointmentId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("event"),
    eventType: z.enum(["webinar", "class"]),
    eventId: z.string().min(1),
  }),
]);

async function postBookingContextCardIfAbsent(
  channelId: string,
  userId: string,
  counterpartyUserId: string,
  contextAppointmentId: string,
): Promise<void> {
  if (!prisma.appointment?.findFirst) return;

  try {
    const appt = await prisma.appointment.findFirst({
      where: { id: contextAppointmentId, deletedAt: null },
      select: {
        id: true,
        appointmentType: true,
        occurrences: {
          where: { deletedAt: null },
          orderBy: { startsAt: "asc" },
          take: 1,
          select: { startsAt: true, endsAt: true },
        },
        participants: {
          where: liveParticipant(),
          select: { userId: true },
        },
        consultation: {
          select: {
            id: true,
            status: true,
            requestedBy: { select: { userId: true } },
            consultationPlan: {
              select: {
                title: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
        subscription: {
          select: {
            id: true,
            status: true,
            requestedBy: { select: { userId: true } },
            subscriptionPlan: {
              select: {
                title: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
        webinar: {
          select: {
            id: true,
            status: true,
            webinarPlan: {
              select: {
                title: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
        class: {
          select: {
            id: true,
            status: true,
            classPlan: {
              select: {
                title: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
      },
    });
    if (!appt) return;

    const matchesPair = (a?: string | null, b?: string | null) =>
      Boolean(
        a &&
        b &&
        ((a === userId && b === counterpartyUserId) ||
          (a === counterpartyUserId && b === userId)),
      );

    const participantIds = new Set(
      (appt.participants ?? []).map((p) => p.userId),
    );
    let title: string | null = null;
    let verified = false;

    if (appt.consultation) {
      const hostId =
        appt.consultation.consultationPlan?.consultantProfile?.userId;
      const clientId = appt.consultation.requestedBy?.userId;
      if (matchesPair(hostId, clientId)) {
        verified = true;
        title = appt.consultation.consultationPlan?.title ?? "Consultation";
      }
    } else if (appt.subscription) {
      const hostId =
        appt.subscription.subscriptionPlan?.consultantProfile?.userId;
      const clientId = appt.subscription.requestedBy?.userId;
      if (matchesPair(hostId, clientId)) {
        verified = true;
        title = appt.subscription.subscriptionPlan?.title ?? "Subscription";
      }
    } else if (appt.webinar) {
      const hostId = appt.webinar.webinarPlan?.consultantProfile?.userId;
      const attendeeId = hostId === userId ? counterpartyUserId : userId;
      if (
        hostId &&
        (hostId === userId || hostId === counterpartyUserId) &&
        participantIds.has(attendeeId)
      ) {
        verified = true;
        title = appt.webinar.webinarPlan?.title ?? "Webinar";
      }
    } else if (appt.class) {
      const hostId = appt.class.classPlan?.consultantProfile?.userId;
      const attendeeId = hostId === userId ? counterpartyUserId : userId;
      if (
        hostId &&
        (hostId === userId || hostId === counterpartyUserId) &&
        participantIds.has(attendeeId)
      ) {
        verified = true;
        title = appt.class.classPlan?.title ?? "Class";
      }
    }

    if (!verified || !title) return;

    const client = getStreamChatClient();
    const channel = client.channel("messaging", channelId);
    const messageId = `booking-context-${appt.id}`;
    const slotStart = appt.occurrences?.[0]?.startsAt ?? null;

    await channel.sendMessage({
      id: messageId,
      user_id: userId,
      text: `Booking context: ${title}`,
      booking_appointment_id: appt.id,
      booking_type: appt.appointmentType,
      booking_title: title,
      ...(slotStart ? { booking_starts_at: slotStart.toISOString() } : {}),
    } as Parameters<typeof channel.sendMessage>[0]);
  } catch (error) {
    streamLogger.debug("Skipped or duplicate booking context card on DM open", {
      channelId,
      contextAppointmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  // Keyed on the user, after auth, before any Prisma or Stream work. This route
  // is cheap to call and expensive to serve — an eligibility check plus a Stream
  // create — and `streamApiLimiter` already existed for exactly this and had no
  // callers. Route-slugged, per the helper's own guidance on sharing a limiter.
  const limited = await applyRateLimit(streamApiLimiter, `open:${userId}`);
  if (limited) return limited;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    if (body.kind === "dm") {
      const { counterpartyUserId, contextAppointmentId } = body;
      const requestedOrgId = body.organizationId ?? null;

      // Covers the self case too — `canDirectMessage` returns false for
      // `a === b` before it touches the database.
      if (!(await canDirectMessage(userId, counterpartyUserId))) {
        streamLogger.warn("Refused DM open — no booking link", {
          userId,
          counterpartyUserId,
        });
        return NextResponse.json(
          {
            error:
              "Direct messages are only available between people who share a booking.",
            eligibleStatuses: DM_ELIGIBLE_STATUSES,
          },
          { status: 403 },
        );
      }

      // Funding-context forgery guard. The channel id is re-derived
      // server-side, but it is a function of the pair AND the funding context —
      // so an org id accepted unchecked would let anyone mint
      // `dmo-<digest(arbitrary)>-…` channels tagged to an organization they
      // have no relation to, and omitting it for an org-funded booking would
      // mint a personal-id channel the reconciler immediately classifies stale.
      // The allowed contexts come from the same rows (and the same
      // `bookingOrgId` precedence) the reconciler's expected-set is built from.
      const contexts = await pairBookingContexts(userId, counterpartyUserId);
      let organizationId: string | null;
      if (requestedOrgId !== null) {
        if (!contexts.organizations.includes(requestedOrgId)) {
          return NextResponse.json(
            {
              error: "No booking ties this conversation to that organization.",
            },
            { status: 403 },
          );
        }
        organizationId = requestedOrgId;
      } else if (contexts.personalAllowed) {
        organizationId = null;
      } else if (contexts.organizations.length === 1) {
        // Personal context requested, but every eligible booking is org-funded:
        // deriving the single real context here instead of minting a channel
        // the reconciler would evict on the next sync.
        organizationId = contexts.organizations[0];
      } else {
        return NextResponse.json(
          {
            error:
              "This conversation exists in multiple organizations — specify which one.",
          },
          { status: 400 },
        );
      }

      // Idempotent: Stream's create is an upsert for an existing id, and the
      // member list is passed atomically so the pair is always both members —
      // which is the whole difference from what `watch()` was doing.
      //
      // The returned `channelId` is used rather than re-deriving it with
      // `getDmChannelId`. Same inputs, same helper, so the two agreed — but
      // deriving an id twice is two chances to derive it differently, and this
      // codebase has already lost conversation history once to exactly that
      // (#1134 P0-3, the `localeCompare` re-keying). One derivation, one source.
      const { channelId } = await createDirectMessageChannel(
        userId,
        counterpartyUserId,
        organizationId,
      );

      if (contextAppointmentId) {
        await postBookingContextCardIfAbsent(
          channelId,
          userId,
          counterpartyUserId,
          contextAppointmentId,
        );
      }

      return NextResponse.json({ channelType: "messaging", channelId });
    }

    const { eventType, eventId } = body;
    if (!(await isEventParticipant(eventType, eventId, userId))) {
      return NextResponse.json(
        { error: "You are not a participant in this event." },
        { status: 403 },
      );
    }

    // Creates the channel with the full roster if absent, adds the caller if
    // present. Also idempotent.
    //
    // #1270 — the result is load-bearing now that a DPDP consent refusal is a
    // skip rather than a throw. Returning 200 here would hand the client a
    // channel id it is not a member of, and the failure would surface later as
    // an empty, un-postable thread.
    const admission = await addUserToEventChannel(eventType, eventId, userId);
    if (!admission.success) {
      return NextResponse.json(
        {
          error:
            "Chat is unavailable because data-processing consent for messaging has not been granted.",
        },
        { status: 403 },
      );
    }

    const channelId =
      eventType === "webinar"
        ? `${WEBINAR_PREFIX}${eventId}`
        : `${CLASS_PREFIX}${eventId}`;
    return NextResponse.json({ channelType: "team", channelId });
  } catch (error) {
    // A refusal is an answer, not an incident. This is currently unreachable —
    // the DM branch checks `canDirectMessage` before calling — but
    // `createDirectMessageChannel` asserts eligibility itself, so a future
    // caller, or a booking cancelled between the check and the create, would
    // otherwise page someone at 3am for a gate doing its job.
    if (error instanceof DmNotPermittedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to open channel", error, { userId });
    return NextResponse.json(
      { error: "Failed to open conversation" },
      { status: 500 },
    );
  }
}
