/**
 * Stream's own record of who was in an occurrence's calls, read once the calls
 * have ended. Every call id the occurrence used (the current one plus each
 * rotation Stream lists under `custom.occurrenceId`) and every session of each
 * call is read, and the answer is typed: a failure is never an empty list.
 */
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import {
  getStreamVideoClient,
  isStreamConfigured,
  streamHttpStatus,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";

/** One device stay, as Stream recorded it; `streamCallId` is the call it belongs to. */
export interface SettledStreamInterval {
  userId: string;
  userSessionId: string;
  streamCallId: string;
  joinedAt: Date;
  leftAt: Date;
}

/**
 * - `read`: every session of every call has ended and was read in full.
 * - `no-session`: Stream affirms no call of the occurrence ever had a session.
 * - `not-final`: a session is still live, or Stream's counts disagree with the rows.
 * - `expired`: Stream no longer holds the detail (HTTP 404, past its 90 days).
 * - `unavailable`: Stream could not be asked or did not answer.
 */
export type SettledAttendanceRead =
  | { kind: "read"; intervals: SettledStreamInterval[] }
  | { kind: "no-session" }
  | { kind: "not-final" }
  | { kind: "expired" }
  | { kind: "unavailable" };

/** An occurrence has its original call id plus one per rotation; more than a page means we cannot list them all. */
const OCCURRENCE_CALLS_PAGE = 25;
const SESSIONS_PAGE = 100;

class NotFinal extends Error {}
class Expired extends Error {}

const toDate = (value: Date | string | undefined | null): Date | null =>
  value ? new Date(value) : null;

type VideoClient = ReturnType<typeof getStreamVideoClient>;

async function listOccurrenceCallIds(
  client: VideoClient,
  occurrenceId: string,
  currentCallId: string,
  failures?: RunFailureReporter,
): Promise<string[]> {
  const page = await withStreamCircuitBreaker(
    () =>
      client.video.queryCalls({
        filter_conditions: { "custom.occurrenceId": { $eq: occurrenceId } },
        limit: OCCURRENCE_CALLS_PAGE,
      }),
    undefined,
    failures,
  );
  // Stream refuses the queryCalls cursor, so a second page means the list is not complete.
  if (page.next) throw new Error("more calls than one page");
  const ids = new Set([toCallId(currentCallId)]);
  for (const entry of page.calls) {
    if (entry.call.type === STREAM_CALL_TYPE) ids.add(entry.call.id);
  }
  return [...ids];
}

async function listCallSessions(
  client: VideoClient,
  callId: string,
  failures?: RunFailureReporter,
) {
  const sessions = [];
  const seen = new Set<string>();
  let next: string | undefined;
  do {
    const cursor = next;
    const page = await withStreamCircuitBreaker(
      () =>
        client.video.queryCallSessionStats({
          filter_conditions: {
            call_cid: { $eq: `${STREAM_CALL_TYPE}:${callId}` },
          },
          limit: SESSIONS_PAGE,
          ...(cursor ? { next: cursor } : {}),
        }),
      undefined,
      failures,
    );
    sessions.push(...page.call_stats);
    next = page.next && !seen.has(page.next) ? page.next : undefined;
    if (next) seen.add(next);
  } while (next);
  return sessions;
}

/** Every device stay of one ended session; refuses a partial or still-open answer. */
async function readSessionParticipants(
  client: VideoClient,
  callId: string,
  sessionId: string,
  failures?: RunFailureReporter,
): Promise<SettledStreamInterval[]> {
  const call = client.video.call(STREAM_CALL_TYPE, callId);
  const intervals: SettledStreamInterval[] = [];
  const seen = new Set<string>();
  let rows = 0;
  let total = 0;
  let next: string | undefined;
  do {
    const cursor = next;
    const page = await withStreamCircuitBreaker(
      () =>
        call.queryCallParticipantSessions({
          session: sessionId,
          ...(cursor ? { next: cursor } : {}),
        }),
      undefined,
      failures,
    ).catch((error: unknown) => {
      // Past Stream's retention the detail is a 404, not an empty list.
      if (streamHttpStatus(error) === 404) throw new Expired();
      throw error;
    });
    if (!page.session?.ended_at) throw new NotFinal("session not ended");
    total = page.total_participant_sessions;
    for (const row of page.participants_sessions) {
      rows++;
      const leftAt = toDate(row.left_at);
      if (!leftAt) throw new NotFinal("a stay has no leave");
      const joinedAt =
        toDate(row.joined_at) ??
        (typeof row.duration_in_seconds === "number"
          ? new Date(leftAt.getTime() - row.duration_in_seconds * 1000)
          : null);
      if (!joinedAt) throw new NotFinal("a stay has no join");
      if (!row.user_id) continue;
      intervals.push({
        userId: row.user_id,
        userSessionId: row.user_session_id || `${sessionId}:${row.user_id}`,
        streamCallId: callId,
        joinedAt,
        leftAt,
      });
    }
    next = page.next && !seen.has(page.next) ? page.next : undefined;
    if (next) seen.add(next);
  } while (next);
  // Filters change only the list, never the total, so the count guards against a partial page.
  if (rows !== total) throw new NotFinal("rows and total disagree");
  return intervals;
}

/** Reads Stream's settled participant record for every call and session of one occurrence. */
export async function readSettledAttendance(args: {
  occurrenceId: string;
  currentCallId: string;
  failures?: RunFailureReporter;
}): Promise<SettledAttendanceRead> {
  if (!isStreamConfigured()) return { kind: "unavailable" };
  const client = getStreamVideoClient();
  try {
    const callIds = await listOccurrenceCallIds(
      client,
      args.occurrenceId,
      args.currentCallId,
      args.failures,
    );
    const intervals: SettledStreamInterval[] = [];
    let sessions = 0;
    for (const callId of callIds) {
      for (const session of await listCallSessions(
        client,
        callId,
        args.failures,
      )) {
        sessions++;
        if (!session.call_ended_at || session.counts.live_sessions > 0) {
          return { kind: "not-final" };
        }
        intervals.push(
          ...(await readSessionParticipants(
            client,
            callId,
            session.call_session_id,
            args.failures,
          )),
        );
      }
    }
    return sessions === 0
      ? { kind: "no-session" }
      : { kind: "read", intervals };
  } catch (error) {
    if (error instanceof NotFinal) return { kind: "not-final" };
    if (error instanceof Expired) return { kind: "expired" };
    return { kind: "unavailable" };
  }
}
