import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { isSupportStreamUser } from "@/lib/stream/support-user";
import { LEGACY_BOOKING_CONTEXT_USER_ID } from "@/lib/stream/system-users";

export interface DmChannelSnapshot {
  /** Members other than Familiarise Support and the retired booking-card user. */
  humans: string[];
  organizationId: string | null;
}

/** One Stream read of a DM the caller belongs to, without messages; null when there is none. */
export async function readDmChannel(
  channelId: string,
  userId: string,
): Promise<DmChannelSnapshot | null> {
  const client = getStreamChatClient();
  const [channel] = await withStreamCircuitBreaker(() =>
    client.queryChannels(
      { cid: { $eq: `messaging:${channelId}` }, members: { $in: [userId] } },
      {},
      {
        limit: 1,
        state: true,
        watch: false,
        presence: false,
        message_limit: 0,
      },
    ),
  );
  if (!channel) return null;
  return {
    humans: Object.keys(channel.state.members).filter(
      (id) => !isSupportStreamUser(id) && id !== LEGACY_BOOKING_CONTEXT_USER_ID,
    ),
    organizationId: channel.data?.organization_id ?? null,
  };
}
