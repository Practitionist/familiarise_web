import { resolveMaxCallDurationSeconds } from "@/lib/meetings/duration-cap";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";

export interface SyncCallWindowInput {
  streamCallId: string;
  startsAt: Date;
  endsAt: Date;
}

/** Synchronizes a Stream call's scheduled window and server-side duration cap when slot bounds change. */
export async function syncMeetingCallWindow(
  input: SyncCallWindowInput,
): Promise<{ maxDurationSeconds: number | null }> {
  const maxDurationSeconds = resolveMaxCallDurationSeconds(
    { endsAt: input.endsAt },
    input.startsAt,
  );
  if (!isStreamConfigured()) {
    return { maxDurationSeconds };
  }

  const durationMinutes = Math.max(
    0,
    Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000),
  );

  await withStreamCircuitBreaker(async () => {
    const call = getStreamVideoClient().video.call(
      STREAM_CALL_TYPE,
      toCallId(input.streamCallId),
    );
    await call.update({
      starts_at: input.startsAt,
      custom: {
        sessionStartsAt: input.startsAt.toISOString(),
        sessionEndsAt: input.endsAt.toISOString(),
        sessionDurationMinutes: durationMinutes,
      },
      ...(maxDurationSeconds !== null
        ? {
            settings_override: {
              limits: { max_duration_seconds: maxDurationSeconds },
            },
          }
        : {}),
    });
  });

  return { maxDurationSeconds };
}
