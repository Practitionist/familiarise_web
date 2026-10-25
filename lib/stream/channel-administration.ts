import type { ChannelFilters, StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import type { MeetingEndReason } from "@/lib/meetings/end-reasons";
import {
  getStreamVideoClient,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { queryChannelsPaged } from "@/lib/stream/batch";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";

export async function queryOrgTaggedChannels(
  chat: StreamChat,
  organizationId: string,
  extraFilter?: ChannelFilters,
) {
  const filter: ChannelFilters = {
    ...extraFilter,
    organization_id: { $eq: organizationId },
  };
  return queryChannelsPaged((opts) =>
    chat.queryChannels(filter, [{ last_message_at: -1 }], opts),
  );
}

async function endSingleStreamVideoCall(
  video: ReturnType<typeof getStreamVideoClient>["video"],
  call: { id: string; streamCallId: string },
  options: {
    now: Date;
    endedReason: MeetingEndReason;
    errorPrefix: string;
    useCircuitBreaker?: boolean;
    failures?: RunFailureReporter;
  },
  errors: string[],
): Promise<boolean> {
  let counted = false;
  let ended = false;
  try {
    const endCall = () =>
      video.call(STREAM_CALL_TYPE, toCallId(call.streamCallId)).end();
    await (options.useCircuitBreaker
      ? withStreamCircuitBreaker(endCall, undefined, options.failures)
      : endCall());
    ended = true;
    counted = true;
  } catch (err) {
    if (isExpectedStreamError(err)) {
      ended = true;
    } else {
      errors.push(
        `${options.errorPrefix} call ${call.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (ended) {
    try {
      await prisma.meeting.updateMany({
        where: { id: call.id, endedAt: null },
        data: { endedAt: options.now, endedReason: options.endedReason },
      });
    } catch (dbErr) {
      errors.push(
        `${options.errorPrefix} meeting update ${call.id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
  }
  return counted;
}

export async function endActiveStreamVideoCalls(
  calls: { id: string; streamCallId: string }[],
  options: {
    now: Date;
    endedReason: MeetingEndReason;
    errorPrefix: string;
    useCircuitBreaker?: boolean;
    failures?: RunFailureReporter;
  },
): Promise<{ callsEnded: number; errors: string[] }> {
  let callsEnded = 0;
  const errors: string[] = [];
  if (calls.length === 0) return { callsEnded, errors };

  try {
    const video = getStreamVideoClient().video;
    for (const call of calls) {
      const counted = await endSingleStreamVideoCall(
        video,
        call,
        options,
        errors,
      );
      if (counted) callsEnded++;
    }
  } catch (err) {
    errors.push(
      `${options.errorPrefix} video client: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { callsEnded, errors };
}
