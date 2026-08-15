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
import { requireApiAuth } from "@/lib/auth-helpers";
import { getDmChannelId } from "@/lib/stream-utils";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import {
  canDirectMessage,
  DM_ELIGIBLE_STATUSES,
} from "@/lib/stream/dm-eligibility";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { addUserToEventChannel } from "@/actions/stream/chat/event-channel.action";
import { streamLogger } from "@/lib/stream-logger";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dm"),
    counterpartyUserId: z.string().min(1),
    /** Funding context. Absent or null = personal. */
    organizationId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal("event"),
    eventType: z.enum(["webinar", "class"]),
    eventId: z.string().min(1),
  }),
]);

/**
 * Is the caller a participant in this event — an attendee on one of its slots,
 * or the host consultant?
 *
 * Deliberately NOT `authorizeEventAccess` from lib/auth-helpers: for webinars
 * and classes that helper authorizes the plan owner and ACCEPTED collaborators
 * only, and returns 403 for attendees. Attendees are exactly who needs the
 * event chat. This mirrors the predicate the search route already applies, so
 * the two cannot disagree about which rows are clickable.
 */
async function isEventParticipant(
  eventType: "webinar" | "class",
  eventId: string,
  userId: string,
): Promise<boolean> {
  if (eventType === "webinar") {
    const hit = await prisma.webinar.findFirst({
      where: {
        id: eventId,
        OR: [
          {
            appointment: {
              deletedAt: null,
              slotsOfAppointment: {
                some: { deletedAt: null, user: { some: { id: userId } } },
              },
            },
          },
          { webinarPlan: { consultantProfile: { userId } } },
        ],
      },
      select: { id: true },
    });
    return !!hit;
  }

  const hit = await prisma.class.findFirst({
    where: {
      id: eventId,
      OR: [
        {
          appointments: {
            some: {
              deletedAt: null,
              slotsOfAppointment: {
                some: { deletedAt: null, user: { some: { id: userId } } },
              },
            },
          },
        },
        { classPlan: { consultantProfile: { userId } } },
      ],
    },
    select: { id: true },
  });
  return !!hit;
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    if (body.kind === "dm") {
      const { counterpartyUserId } = body;
      const organizationId = body.organizationId ?? null;

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

      // Idempotent: Stream's create is an upsert for an existing id, and the
      // member list is passed atomically so the pair is always both members —
      // which is the whole difference from what `watch()` was doing.
      await createDirectMessageChannel(
        userId,
        counterpartyUserId,
        organizationId,
      );

      const channelId = getDmChannelId(
        userId,
        counterpartyUserId,
        organizationId,
      );
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
    await addUserToEventChannel(eventType, eventId, userId);

    const channelId =
      eventType === "webinar"
        ? `${WEBINAR_PREFIX}${eventId}`
        : `${CLASS_PREFIX}${eventId}`;
    return NextResponse.json({ channelType: "team", channelId });
  } catch (error) {
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
