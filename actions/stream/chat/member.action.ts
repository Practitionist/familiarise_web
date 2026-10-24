"use server";

/**
 * Client-callable channel membership mutation.
 *
 * Lives in its own `"use server"` file, deliberately separate from
 * `channel.action.ts`: that module lost its directive (architecture review
 * F-HIGH-1) so its exports can never be invoked from a browser, but THIS
 * operation is genuinely client-facing — `ChannelInfoAndManageDialog` calls it
 * to add members through the server-side authorization gate (#899) instead of
 * `channel.addMembers()` straight from the browser. A gated action in a
 * dedicated file is the sanctioned shape for that (see the header comment in
 * `channel.action.ts`).
 *
 * Stream's server-side API bypasses its permission system entirely, so the
 * authz gate lives here. Membership of a Postgres-derived channel comes only
 * from eligibility, so non-staff are refused there and a staff add is audited;
 * elsewhere only the channel's creator may add.
 */
import { z } from "zod";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  getChannelTypeFromId,
  isDMChannel,
  isManagedChannel,
} from "@/lib/stream-channel-ids";
import { Refusal, type RefusalShape } from "@/lib/errors/refusal";
import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { upsertUserToStream } from "./user.action";
import { isUpsertRefusal } from "@/lib/stream/connect-failure";
import * as Sentry from "@sentry/nextjs";

const STREAM_SERVER_TRUSTED = Symbol.for("familiarise.stream.serverTrusted");

const channelIdSchema = z.string().min(1, "Channel ID is required");
const memberIdSchema = z.string().min(1, "Member ID is required");

const derivedChannelRefusal = new Refusal({
  code: "DERIVED_CHANNEL_MEMBERSHIP",
  httpStatus: 403,
  userMessage:
    "Members join this conversation through their bookings and roles, so they can't be added by hand.",
});

export type AddMemberResult =
  | { success: true; response: unknown }
  | { success: false; refusal: RefusalShape };

export async function addMemberToChannel(
  channelId: string,
  userId: string,
  _channelType?: "messaging" | "team",
): Promise<AddMemberResult> {
  channelIdSchema.parse(channelId);
  memberIdSchema.parse(userId);

  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error("Unauthorized: sign in to manage channel members");
  }
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }

  // DM membership is pair-derived (`getDmChannelId` + `canDirectMessage`).
  // Allowing a DM creator to name a third member here would bypass that
  // eligibility gate with server credentials — so direct-message channels are
  // out of scope for this action entirely.
  if (isDMChannel(channelId)) {
    throw new Error("Forbidden: members cannot be added to direct messages");
  }

  const privileged = isPrivileged(session.user.role);
  const derived = isManagedChannel(channelId);
  if (derived && !privileged) {
    streamLogger.warn("Refused manual add to a derived channel", {
      channelId,
      userId,
    });
    return { success: false, refusal: derivedChannelRefusal.toShape() };
  }

  const client = getStreamChatClient();

  // Always derive channel type from the canonical channel ID prefix rather than
  // trusting a client-supplied channelType argument.
  const resolvedChannelType = getChannelTypeFromId(channelId);

  streamLogger.debug("Adding member to channel", {
    channelId,
    userId,
    channelType: resolvedChannelType,
  });

  try {
    const channel = client.channel(resolvedChannelType, channelId);
    if (privileged) {
      await channel.create(); // Creates if doesn't exist, no-op if exists
    } else {
      const state = await channel.query({});
      const createdById = state.channel?.created_by?.id;
      if (createdById !== session.user.id) {
        throw new Error(
          "Forbidden: only the channel creator or staff may add members",
        );
      }
    }

    const upsertOutcome = await upsertUserToStream(userId, {
      serverTrusted: STREAM_SERVER_TRUSTED,
    });
    if (isUpsertRefusal(upsertOutcome)) {
      throw new Error("Forbidden: target user cannot be synced to Stream");
    }

    const response = await channel.addMembers([userId]);
    if (derived) {
      await recordStaffAdd(
        session.user.id,
        session.user.role,
        channelId,
        userId,
      );
    }

    streamLogger.debug("Member added successfully", { channelId, userId });
    return { success: true, response };
  } catch (error) {
    streamLogger.error("Failed to add member to channel", error, {
      channelId,
      userId,
    });
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    throw error;
  }
}

async function recordStaffAdd(
  actorUserId: string,
  actorRole: string | null | undefined,
  channelId: string,
  userId: string,
): Promise<void> {
  try {
    const { recordOpsAction } = await import("@/lib/backoffice/ops-action-log");
    await recordOpsAction(prisma, {
      actorUserId,
      actorRole: String(actorRole ?? "STAFF"),
      surface: "supportChat.intervene",
      action: "stream.channel.member.add",
      targetKind: "StreamChannel",
      targetId: channelId,
      reason: "Staff added a member to a Postgres-derived chat channel",
      after: { userId },
    });
  } catch (auditErr) {
    reportSentryError(auditErr, {
      subsystem: "stream",
      op: "member.add.audit",
      extra: { channelId },
    });
  }
}
