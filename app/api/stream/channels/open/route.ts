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
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import {
  CLASS_PREFIX,
  collabChannelId,
  WEBINAR_PREFIX,
} from "@/lib/stream-channel-ids";
import {
  canDirectMessage,
  DmNotPermittedError,
  pairBookingContexts,
  resolveVerifiedBookingContextTitle,
} from "@/lib/stream/dm-eligibility";
import { DM_ELIGIBLE_STATUSES } from "@/lib/stream/dm-eligibility-statuses";
import { applyRateLimit, streamApiLimiter } from "@/lib/rate-limit";
import {
  createCollaboratorChannel,
  createDirectMessageChannel,
} from "@/actions/stream/chat/channel.action";
import {
  addUserToEventChannel,
  isEventParticipant,
} from "@/lib/stream/event-channel-service";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { hasAnyOrgPermission } from "@/lib/auth/org-permissions";

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
  z.object({
    kind: z.literal("collab"),
    webinarPlanId: z.string().min(1).optional(),
    classPlanId: z.string().min(1).optional(),
  }),
]);

function buildBookingContextMessageId(
  channelId: string,
  appointmentId: string,
): string {
  const digest = createHash("sha256")
    .update(`${channelId}:${appointmentId}`)
    .digest("hex")
    .slice(0, 32);
  return `booking-ctx-${digest}`;
}

async function isAuthorizedForCollabChannel(
  userId: string,
  userRole: string | undefined,
  planType: "webinar" | "class",
  planId: string,
): Promise<boolean | null> {
  const collaboratorWhere = {
    status: "ACCEPTED" as const,
    consultantProfile: { deletedAt: null },
  };
  const plan =
    planType === "webinar"
      ? await prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: {
            id: true,
            organizationId: true,
            consultantProfile: { select: { userId: true } },
            collaborators: {
              where: collaboratorWhere,
              select: { consultantProfile: { select: { userId: true } } },
            },
          },
        })
      : await prisma.classPlan.findUnique({
          where: { id: planId },
          select: {
            id: true,
            organizationId: true,
            consultantProfile: { select: { userId: true } },
            collaborators: {
              where: collaboratorWhere,
              select: { consultantProfile: { select: { userId: true } } },
            },
          },
        });

  if (!plan) return null;

  if (plan.consultantProfile?.userId === userId) return true;
  if (plan.collaborators.some((c) => c.consultantProfile.userId === userId)) {
    return true;
  }
  if (userRole && isPrivileged(userRole)) return true;

  if (plan.organizationId && prisma.membership?.findFirst) {
    const membership = await prisma.membership.findFirst({
      where: {
        organizationId: plan.organizationId,
        userId,
        status: "ACTIVE",
      },
      select: { role: true },
    });
    if (
      membership &&
      hasAnyOrgPermission(membership.role, ["messaging.read", "catalog.manage"])
    ) {
      return true;
    }
  }

  return false;
}

async function postBookingContextCardIfAbsent(
  channelId: string,
  userId: string,
  counterpartyUserId: string,
  contextAppointmentId: string,
): Promise<void> {
  if (!prisma.appointment?.findFirst) return;

  try {
    const collaboratorSelect = {
      where: {
        status: "ACCEPTED" as const,
        consultantProfile: { deletedAt: null },
      },
      select: {
        tier: true,
        consultantProfile: { select: { userId: true } },
      },
    };
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
          select: { userId: true, role: true },
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
                collaborators: collaboratorSelect,
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
                collaborators: collaboratorSelect,
              },
            },
          },
        },
      },
    });
    if (!appt) return;

    const title = resolveVerifiedBookingContextTitle(
      appt,
      userId,
      counterpartyUserId,
    );
    if (!title) return;

    const client = getStreamChatClient();
    const channel = client.channel("messaging", channelId);
    const messageId = buildBookingContextMessageId(channelId, appt.id);
    const slotStart = appt.occurrences?.[0]?.startsAt ?? null;
    const messagePayload: Record<string, unknown> = {
      id: messageId,
      user_id: userId,
      text: `Booking context: ${title}`,
      booking_appointment_id: appt.id,
      booking_type: appt.appointmentType,
      booking_title: title,
      ...(slotStart ? { booking_starts_at: slotStart.toISOString() } : {}),
    };

    await channel.sendMessage(messagePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isDuplicate = /already exists|duplicate/i.test(message);
    if (isDuplicate) {
      streamLogger.debug("Booking context card already present on DM open", {
        channelId,
        contextAppointmentId,
      });
    } else {
      streamLogger.warn("Failed to post booking context card on DM open", {
        channelId,
        contextAppointmentId,
        error: message,
      });
    }
  }
}

async function handleCollabChannelOpen(
  userId: string,
  userRole: string | undefined,
  body: Extract<z.infer<typeof bodySchema>, { kind: "collab" }>,
): Promise<NextResponse> {
  if (Boolean(body.webinarPlanId) === Boolean(body.classPlanId)) {
    return NextResponse.json(
      { error: "Specify either webinarPlanId or classPlanId" },
      { status: 400 },
    );
  }
  const planType = body.webinarPlanId ? "webinar" : "class";
  const planId = (body.webinarPlanId ?? body.classPlanId)!;

  const authorized = await isAuthorizedForCollabChannel(
    userId,
    userRole,
    planType,
    planId,
  );
  if (authorized === null) {
    return NextResponse.json({ error: "Plan not found." }, { status: 404 });
  }
  if (!authorized) {
    return NextResponse.json(
      { error: "You do not have access to this collaborator channel." },
      { status: 403 },
    );
  }

  const reconciled = await createCollaboratorChannel(planType, planId);
  if (!reconciled) {
    return NextResponse.json(
      { error: "Collaborator channel not available" },
      { status: 404 },
    );
  }

  const channelId = collabChannelId(planType, planId);
  return NextResponse.json({ channelType: "messaging", channelId });
}

function resolveDmOrganizationId(
  requestedOrgId: string | null,
  contexts: Awaited<ReturnType<typeof pairBookingContexts>>,
): { organizationId: string | null } | { error: NextResponse } {
  if (requestedOrgId !== null) {
    if (!contexts.organizations.includes(requestedOrgId)) {
      return {
        error: NextResponse.json(
          {
            error: "No booking ties this conversation to that organization.",
          },
          { status: 403 },
        ),
      };
    }
    return { organizationId: requestedOrgId };
  }
  if (contexts.personalAllowed) {
    return { organizationId: null };
  }
  if (contexts.organizations.length === 1) {
    return { organizationId: contexts.organizations[0] };
  }
  return {
    error: NextResponse.json(
      {
        error:
          "This conversation exists in multiple organizations — specify which one.",
      },
      { status: 400 },
    ),
  };
}

async function handleDmChannelOpen(
  userId: string,
  body: Extract<z.infer<typeof bodySchema>, { kind: "dm" }>,
): Promise<NextResponse> {
  const { counterpartyUserId, contextAppointmentId } = body;
  const requestedOrgId = body.organizationId ?? null;

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

  const contexts = await pairBookingContexts(userId, counterpartyUserId);
  const resolvedOrg = resolveDmOrganizationId(requestedOrgId, contexts);
  if ("error" in resolvedOrg) return resolvedOrg.error;

  const { channelId } = await createDirectMessageChannel(
    userId,
    counterpartyUserId,
    resolvedOrg.organizationId,
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

async function handleEventChannelOpen(
  userId: string,
  body: Extract<z.infer<typeof bodySchema>, { kind: "event" }>,
): Promise<NextResponse> {
  const { eventType, eventId } = body;
  if (!(await isEventParticipant(eventType, eventId, userId))) {
    return NextResponse.json(
      { error: "You are not a participant in this event." },
      { status: 403 },
    );
  }

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
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

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
    if (body.kind === "collab") {
      return await handleCollabChannelOpen(
        userId,
        auth.session.user.role,
        body,
      );
    }
    if (body.kind === "dm") {
      return await handleDmChannelOpen(userId, body);
    }
    return await handleEventChannelOpen(userId, body);
  } catch (error) {
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
