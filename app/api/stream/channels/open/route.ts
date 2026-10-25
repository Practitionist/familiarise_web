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

import { requireApiAuth } from "@/lib/auth-helpers";
import {
  CLASS_PREFIX,
  collabChannelId,
  WEBINAR_PREFIX,
} from "@/lib/stream-channel-ids";
import {
  canDirectMessage,
  DmNotPermittedError,
  pairBookingContexts,
} from "@/lib/stream/dm-eligibility";
import { DM_ELIGIBLE_STATUSES } from "@/lib/stream/dm-eligibility-statuses";
import { applyRateLimit, streamApiLimiter } from "@/lib/rate-limit";
import {
  createCollaboratorChannel,
  createDirectMessageChannel,
} from "@/actions/stream/chat/channel.action";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import {
  addUserToEventChannel,
  isEventParticipant,
} from "@/lib/stream/event-channel-service";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { collabChannelAccess } from "@/lib/stream/channel-access";
import { Refusal } from "@/lib/errors/refusal";

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
  z.object({
    kind: z.literal("collab"),
    webinarPlanId: z.string().min(1).optional(),
    classPlanId: z.string().min(1).optional(),
  }),
]);

const collabChannelRefusals = {
  orgDeactivated: new Refusal({
    code: "ORG_DEACTIVATED",
    httpStatus: 403,
    userMessage:
      "This organization has been deactivated, so its collaborator chat is closed.",
  }),
  frozen: new Refusal({
    code: "CHANNEL_FROZEN",
    httpStatus: 423,
    userMessage: "This collaborator chat is read-only and cannot be reopened.",
  }),
};

function refusalJson(refusal: Refusal): NextResponse {
  return NextResponse.json(
    { error: refusal.userMessage, code: refusal.code },
    { status: refusal.httpStatus },
  );
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

  const access = await collabChannelAccess(userId, userRole, planType, planId);
  if (access === "not_found") {
    return NextResponse.json({ error: "Plan not found." }, { status: 404 });
  }
  if (access === "org_deactivated") {
    return refusalJson(collabChannelRefusals.orgDeactivated);
  }
  if (access === "forbidden") {
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
  // A wind-down or moderation freeze is never lifted by opening the channel.
  if (reconciled.frozen) {
    return refusalJson(collabChannelRefusals.frozen);
  }

  const channelId = collabChannelId(planType, planId);
  await upsertUsersToStream([userId]);
  await getStreamChatClient()
    .channel("messaging", channelId)
    .addMembers([userId])
    .catch(() => {});
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
  const { counterpartyUserId } = body;
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
  if (admission.reason === "member_not_added") {
    return NextResponse.json(
      { error: "Chat could not be opened right now. Please try again." },
      { status: 503 },
    );
  }
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
