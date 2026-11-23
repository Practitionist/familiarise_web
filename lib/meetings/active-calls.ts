import type { PrismaLike } from "@/lib/prisma";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import {
  parseSlotIdFromCallId,
  STREAM_CALL_TYPE,
  toCallId,
} from "@/lib/stream/call-cid";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";

/** Stream's one usable queryCalls page; its `next` cursor is refused (see scripts/stream/backfill-call-member-role.ts). */
const ONGOING_PAGE_SIZE = 100;
export const STREAM_LOOKUP_TIMEOUT_MS = 5_000;

export interface ActiveCallCount {
  /** Rooms that are, or may be, live; includes `unverified`. */
  active: number;
  /** Rooms Stream could not confirm either way, counted as active. */
  unverified: number;
  /** False when Stream could not be asked or listed only part of its calls, so a live call may be missing. */
  streamChecked: boolean;
}

/** One key per session, so a rotated `-r…` call id and its room's stored id count once. */
function sessionKey(callId: string): string {
  return parseSlotIdFromCallId(callId) ?? toCallId(callId);
}

class OngoingLookupTimeout extends Error {
  constructor() {
    super(
      `Stream ongoing-call lookup timed out after ${STREAM_LOOKUP_TIMEOUT_MS}ms`,
    );
    this.name = "OngoingLookupTimeout";
  }
}

/** The ids of calls Stream reports as ongoing, and whether its one page held them all. */
async function readOngoingCallIds(failures: RunFailureReporter): Promise<{
  ids: Set<string>;
  complete: boolean;
}> {
  const lookup = withStreamCircuitBreaker(
    () =>
      getStreamVideoClient().video.queryCalls({
        filter_conditions: { type: STREAM_CALL_TYPE, ongoing: true },
        limit: ONGOING_PAGE_SIZE,
      }),
    undefined,
    failures,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OngoingLookupTimeout()),
      STREAM_LOOKUP_TIMEOUT_MS,
    );
  });
  const page = await Promise.race([lookup, timeout]).finally(() =>
    clearTimeout(timer),
  );
  return {
    ids: new Set(page.calls.map((entry) => entry.call.id)),
    complete: !page.next,
  };
}

/**
 * Counts sessions that may be live: any call Stream lists as ongoing, even when
 * its room is closed, plus every open room Stream could not confirm either way.
 */
export async function countActiveCalls(
  db: PrismaLike,
): Promise<ActiveCallCount> {
  const rooms = await db.meeting.findMany({
    where: { endedAt: null },
    select: { streamCallId: true },
  });
  const uncertain = new Set(rooms.map((r) => sessionKey(r.streamCallId)));

  const failures = createRunFailureReporter("stream");
  try {
    if (!isStreamConfigured()) throw new Error("Stream is not configured");
    const { ids, complete } = await readOngoingCallIds(failures);
    const ongoing = new Set([...ids].map(sessionKey));
    const unverified = complete
      ? 0
      : [...uncertain].filter((key) => !ongoing.has(key)).length;
    return {
      active: ongoing.size + unverified,
      unverified,
      streamChecked: complete,
    };
  } catch (error) {
    // The breaker already reported a Stream error into `failures`; only the timeout is unseen.
    if (error instanceof OngoingLookupTimeout) {
      failures.add("maintenance-preflight.ongoing-calls", error, {
        rooms: uncertain.size,
      });
    }
    return {
      active: uncertain.size,
      unverified: uncertain.size,
      streamChecked: false,
    };
  } finally {
    failures.flush();
  }
}
