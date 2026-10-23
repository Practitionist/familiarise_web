/**
 * Locks a booking chat's membership and history while Familiarise Support
 * intervenes. While an INTERVENE grant on the channel is live, per-channel
 * grant modifiers revoke member changes and owner truncation for the `user`
 * and `channel_moderator` roles; when the last one ends they are cleared. A
 * covert READ changes nothing in Stream, so a party can still truncate under it.
 * Server client only, never `watch()`, never inside a transaction.
 */

import type { ChannelConfigFields } from "stream-chat";

import prisma from "@/lib/prisma";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { isMissingChannelError } from "@/lib/stream/support-intervention";

/** Stream's messaging defaults give `user` the -owner variants and `channel_moderator` the plain ones. */
const REVOKED = [
  "!update-channel-members",
  "!update-channel-members-owner",
  "!truncate-channel-owner",
];

type GrantModifiers = Record<"user" | "channel_moderator", string[]>;

export const SUPPORT_BOUNDARY_GRANTS: GrantModifiers = {
  user: REVOKED,
  channel_moderator: REVOKED,
};

/** Empty per-role lists clear the modifiers whether Stream merges or replaces `config_overrides`. */
export const CLEARED_BOUNDARY_GRANTS: GrantModifiers = {
  user: [],
  channel_moderator: [],
};

export type BoundaryOutcome = "locked" | "unlocked" | "gone";

/**
 * Brings the channel's grant modifiers in line with its live interventions. The
 * desired state is read from the database at call time, so a repeat or a
 * late retry converges; nothing else writes `config_overrides`.
 */
export async function syncSupportBoundary(
  channelType: string,
  channelId: string,
  now = new Date(),
): Promise<BoundaryOutcome> {
  const live = await prisma.supportCaseChatAccess.findFirst({
    where: {
      kind: "INTERVENE",
      channelType,
      channelId,
      endedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  // `grants` is a documented override the SDK's config type omits.
  const config_overrides: Partial<ChannelConfigFields> & {
    grants: GrantModifiers;
  } = { grants: live ? SUPPORT_BOUNDARY_GRANTS : CLEARED_BOUNDARY_GRANTS };
  try {
    await withStreamCircuitBreaker(() =>
      getStreamChatClient()
        .channel(channelType, channelId)
        .updatePartial({ set: { config_overrides } }),
    );
  } catch (err) {
    if (isMissingChannelError(err)) return "gone";
    throw err;
  }
  return live ? "locked" : "unlocked";
}
