/**
 * Stream's own record of who was in an occurrence's calls, read once the calls
 * have ended and Stream has announced each session's report ready. Every call
 * id the occurrence used (the current one plus each rotation Stream lists under
 * `custom.occurrenceId`) and every session of each call is read, and the answer
 * is typed: a failure is never an empty list.
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
 * - `not-final`: a session is still live, its report is not announced ready,
 *   a session known elsewhere is missing from the list, or the counts disagree.
 * - `expired`: Stream no longer holds the detail (HTTP 404 on a session past its 90 days).
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

/** Stream keeps per-device detail this long after a session ends; a 404 sooner is a detail not generated yet. */
const PARTICIPANT_DETAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

class NotFinal extends Error {}
class Expired extends Error {}

const toDate = (value: Date | string | undefined | null): Date | null =>
  value ? new Date(value) : null;

/** One read's Stream client, run reporter and the instant by which every request must have answered. */
interface Reader {
  client: ReturnType<typeof getStreamVideoClient>;
  failures?: RunFailureReporter;
  deadlineAt?: number;
}

class DeadlineExceeded extends Error {}

/** One Stream request through the breaker, abandoned once the read's deadline passes. */
async function ask<T>(reader: Reader, op: () => Promise<T>): Promise<T> {
  if (reader.deadlineAt === undefined) {
    return withStreamCircuitBreaker(op, undefined, reader.failures);
  }
  const remaining = reader.deadlineAt - Date.now();
  if (remaining <= 0) throw new DeadlineExceeded();
  const request = withStreamCircuitBreaker(op, undefined, reader.failures);
  // A request that answers after the deadline is dropped, not reported as unhandled.
  request.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), remaining);
  });
  return Promise.race([request, expiry]).finally(() => clearTimeout(timer));
}

/** The next page's cursor; a cursor seen before means the listing is looping, so the read is not final. */
function nextCursor(next: string | undefined, seen: Set<string>) {
  if (!next) return undefined;
  if (seen.has(next)) throw new NotFinal("cursor repeated");
  seen.add(next);
  return next;
}

/** A call the occurrence used, with the session Stream names as its current one (none once the call is idle). */
interface OccurrenceCall {
  id: string;
  currentSessionId: string | null;
  currentSessionEnded: boolean;
}

type CallFields = {
  id: string;
  current_session_id?: string;
  session?: { ended_at?: Date | string | null } | null;
};

const toOccurrenceCall = (call: CallFields): OccurrenceCall => ({
  id: call.id,
  currentSessionId: call.current_session_id || null,
  currentSessionEnded: Boolean(call.session?.ended_at),
});

async function listOccurrenceCalls(
  reader: Reader,
  occurrenceId: string,
  currentCallId: string,
  /** The room's call id is a pre-start replacement no join has provisioned yet. */
  currentCallReserved: boolean,
): Promise<OccurrenceCall[]> {
  const page = await ask(reader, () =>
    reader.client.video.queryCalls({
      filter_conditions: { "custom.occurrenceId": { $eq: occurrenceId } },
      limit: OCCURRENCE_CALLS_PAGE,
    }),
  );
  // Stream refuses the queryCalls cursor, so a second page means the list is not complete.
  if (page.next) throw new Error("more calls than one page");
  const calls = new Map<string, OccurrenceCall>();
  for (const entry of page.calls) {
    if (entry.call.type === STREAM_CALL_TYPE) {
      calls.set(entry.call.id, toOccurrenceCall(entry.call));
    }
  }
  const current = toCallId(currentCallId);
  if (!calls.has(current)) {
    // The room's own call must be accounted for even when the listing missed it.
    const fetched = await ask(reader, () =>
      reader.client.video.call(STREAM_CALL_TYPE, current).get(),
    ).catch((error: unknown) => {
      // A reserved replacement was never created, so it holds no session; any other 404 stays doubt.
      if (currentCallReserved && streamHttpStatus(error) === 404) return null;
      throw error;
    });
    if (fetched) calls.set(current, toOccurrenceCall(fetched.call));
  }
  return [...calls.values()];
}

async function listCallSessions(reader: Reader, callId: string) {
  const sessions = [];
  const seen = new Set<string>();
  let next: string | undefined;
  do {
    const cursor = next;
    const page = await ask(reader, () =>
      reader.client.video.queryCallSessionStats({
        filter_conditions: {
          call_cid: { $eq: `${STREAM_CALL_TYPE}:${callId}` },
        },
        limit: SESSIONS_PAGE,
        ...(cursor ? { next: cursor } : {}),
      }),
    );
    sessions.push(...page.call_stats);
    next = nextCursor(page.next, seen);
  } while (next);
  return sessions;
}

/** Every device stay of one ended session; refuses a partial or still-open answer. */
async function readSessionParticipants(
  reader: Reader,
  callId: string,
  session: {
    id: string;
    endedAt: Date;
    /** Session stats' own counts: device stays and distinct people. */
    counts: { sessions: number; participants: number };
  },
): Promise<SettledStreamInterval[]> {
  const sessionId = session.id;
  const call = reader.client.video.call(STREAM_CALL_TYPE, callId);
  const intervals: SettledStreamInterval[] = [];
  const seen = new Set<string>();
  let rows = 0;
  let total = 0;
  let next: string | undefined;
  do {
    const cursor = next;
    const page = await ask(reader, () =>
      call.queryCallParticipantSessions({
        session: sessionId,
        ...(cursor ? { next: cursor } : {}),
      }),
    ).catch((error: unknown) => {
      // Past Stream's retention the detail is a 404, not an empty list.
      if (streamHttpStatus(error) !== 404) throw error;
      const age = Date.now() - session.endedAt.getTime();
      throw age >= PARTICIPANT_DETAIL_RETENTION_MS
        ? new Expired()
        : new NotFinal("detail not available yet");
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
      if (!row.user_id) throw new NotFinal("a stay names no user");
      intervals.push({
        userId: row.user_id,
        userSessionId: row.user_session_id || `${sessionId}:${row.user_id}`,
        streamCallId: callId,
        joinedAt,
        leftAt,
      });
    }
    next = nextCursor(page.next, seen);
  } while (next);
  // Filters change only the list, never the total, so the count guards against a partial page.
  if (rows !== total) throw new NotFinal("rows and total disagree");
  // A repeated row would pass the count and then vanish on insert; session stats must agree too.
  const stays = new Set(intervals.map((i) => i.userSessionId));
  const people = new Set(intervals.map((i) => i.userId));
  if (stays.size !== rows) throw new NotFinal("a stay is repeated");
  if (
    stays.size < session.counts.sessions ||
    people.size < session.counts.participants
  ) {
    throw new NotFinal("fewer stays than session stats count");
  }
  return intervals;
}

/**
 * Reads Stream's settled participant record for every call and session of one
 * occurrence. A session is read only once its report is announced ready
 * (`readySessionIds`), or, with `fallback`, once the room end is long past; and
 * every session known elsewhere (announced ready, named by the call, or seen by
 * our room-state webhooks) must appear in session stats. With `deadlineAt`
 * (epoch ms) every request must answer by then; a read that runs out of time
 * is `unavailable` and returns nothing partial.
 */
export async function readSettledAttendance(args: {
  occurrenceId: string;
  currentCallId: string;
  readySessionIds: readonly string[];
  /** The latest session the room-state webhooks saw on the room's call. */
  lastKnownSessionId: string | null;
  /** The room end is far enough past that a session with no ready announcement may be read. */
  fallback: boolean;
  currentCallReserved: boolean;
  failures?: RunFailureReporter;
  deadlineAt?: number;
}): Promise<SettledAttendanceRead> {
  if (!isStreamConfigured()) return { kind: "unavailable" };
  const reader: Reader = {
    client: getStreamVideoClient(),
    failures: args.failures,
    deadlineAt: args.deadlineAt,
  };
  const ready = new Set(args.readySessionIds);
  try {
    const calls = await listOccurrenceCalls(
      reader,
      args.occurrenceId,
      args.currentCallId,
      args.currentCallReserved,
    );
    const known = new Set(ready);
    if (args.lastKnownSessionId) known.add(args.lastKnownSessionId);
    const listedByCall = new Map<
      string,
      Awaited<ReturnType<typeof listCallSessions>>
    >();
    for (const call of calls) {
      const listed = await listCallSessions(reader, call.id);
      // A session the call itself names but stats do not list yet, or one still running, is not final.
      if (call.currentSessionId) {
        known.add(call.currentSessionId);
        if (!call.currentSessionEnded) return { kind: "not-final" };
      }
      listedByCall.set(call.id, listed);
    }
    const listedIds = new Set(
      [...listedByCall.values()].flat().map((s) => s.call_session_id),
    );
    // Stats may lag: a session we know of from any other source must be listed before the record is complete.
    for (const id of known) {
      if (!listedIds.has(id)) return { kind: "not-final" };
    }
    const corroborated =
      args.lastKnownSessionId !== null ||
      calls.some((call) => call.currentSessionId !== null);
    const intervals: SettledStreamInterval[] = [];
    for (const [callId, listed] of listedByCall) {
      for (const session of listed) {
        if (!session.call_ended_at || session.counts.live_sessions > 0) {
          return { kind: "not-final" };
        }
        // Without its ready announcement a session is read only in the fallback, and only when
        // our webhooks or the call itself name a session that stats list (checked above).
        if (
          !ready.has(session.call_session_id) &&
          (!args.fallback || !corroborated)
        ) {
          return { kind: "not-final" };
        }
        intervals.push(
          ...(await readSessionParticipants(reader, callId, {
            id: session.call_session_id,
            endedAt: new Date(session.call_ended_at),
            counts: session.counts,
          })),
        );
      }
    }
    return listedIds.size === 0
      ? { kind: "no-session" }
      : { kind: "read", intervals };
  } catch (error) {
    if (error instanceof NotFinal) return { kind: "not-final" };
    if (error instanceof Expired) return { kind: "expired" };
    return { kind: "unavailable" };
  }
}
