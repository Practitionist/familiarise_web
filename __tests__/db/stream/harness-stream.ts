/**
 * A stand-in for Stream's video API for the database tier: the calls an
 * occurrence lists (with each call's current session), each call's sessions
 * and their aggregate counts, and each session's device stays.
 * `jest.mock("../../../lib/stream-client", () => jest.requireActual("./harness-stream").fakeStreamClient)`.
 */

export interface FakeStay {
  userId: string;
  userSessionId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface FakeSession {
  id: string;
  live: boolean;
  stays: FakeStay[];
  /** Not yet listed by session stats, though the call may name it as current. */
  hiddenFromStats?: boolean;
  /** Session stats' own counts; derived from `stays` when absent. */
  counts?: { participants: number; sessions: number };
  /** When the session started, for the call's current-session record. */
  startedAt?: Date;
}

export interface FakeCall {
  occurrenceId: string;
  sessions: FakeSession[];
  /** The session the call itself names as current; empty once the call is idle. */
  currentSessionId?: string;
}

export const fakeStream = {
  /** Call id to its record; a call listed here is returned for its occurrence. */
  calls: new Map<string, FakeCall>(),
  /** When set, every request fails with this HTTP status. */
  failStatus: null as number | null,
  /** When set, every request hangs and never answers. */
  stall: false,
  /** When set, `call.get()` takes its answer at once but returns it only once this settles. */
  getGate: null as Promise<void> | null,
  /** How many `call.get()` requests have taken their answer. */
  gets: 0,
  requests: 0,
  reset() {
    this.calls.clear();
    this.failStatus = null;
    this.stall = false;
    this.getGate = null;
    this.gets = 0;
    this.requests = 0;
  },
};

async function guard() {
  fakeStream.requests++;
  if (fakeStream.stall) await new Promise(() => undefined);
  if (fakeStream.failStatus !== null) {
    throw Object.assign(new Error("fake Stream failure"), {
      status: fakeStream.failStatus,
    });
  }
}

const ENDED_AT = "2026-01-01T00:00:00.000Z";
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Stream ends an idle session 300 seconds after its last leave. */
function endedAtOf(s: FakeSession): string {
  const lastLeave = Math.max(
    ...s.stays.map((st) => st.leftAt?.getTime() ?? -Infinity),
  );
  return Number.isFinite(lastLeave)
    ? new Date(lastLeave + IDLE_TIMEOUT_MS).toISOString()
    : ENDED_AT;
}

/** A call as Stream's call listing and `call.get()` describe it. */
function callResponse(id: string, call: FakeCall) {
  const current = call.currentSessionId
    ? call.sessions.find((s) => s.id === call.currentSessionId)
    : undefined;
  return {
    id,
    type: "default",
    current_session_id: call.currentSessionId ?? "",
    session: current
      ? {
          id: current.id,
          ...(current.startedAt
            ? { started_at: current.startedAt.toISOString() }
            : {}),
          ...(current.live ? {} : { ended_at: endedAtOf(current) }),
        }
      : null,
  };
}

const countsOf = (s: FakeSession) =>
  s.counts ?? {
    participants: new Set(s.stays.map((st) => st.userId)).size,
    sessions: s.stays.length,
  };

export const fakeStreamClient = {
  isStreamConfigured: () => true,
  withStreamCircuitBreaker: <T>(op: () => Promise<T>) => op(),
  streamHttpStatus: (e: { status?: number }) => e?.status ?? null,
  getStreamVideoClient: () => ({
    video: {
      queryCalls: async (req: {
        filter_conditions: { "custom.occurrenceId": { $eq: string } };
      }) => {
        await guard();
        const occurrenceId = req.filter_conditions["custom.occurrenceId"].$eq;
        return {
          calls: [...fakeStream.calls]
            .filter(([, c]) => c.occurrenceId === occurrenceId)
            .map(([id, c]) => ({ call: callResponse(id, c) })),
        };
      },
      queryCallSessionStats: async (req: {
        filter_conditions: { call_cid: { $eq: string } };
      }) => {
        await guard();
        const callId = req.filter_conditions.call_cid.$eq.replace(
          /^default:/,
          "",
        );
        return {
          call_stats: (fakeStream.calls.get(callId)?.sessions ?? [])
            .filter((s) => !s.hiddenFromStats)
            .map((s) => ({
              call_session_id: s.id,
              ...(s.live ? {} : { call_ended_at: endedAtOf(s) }),
              counts: { ...countsOf(s), live_sessions: s.live ? 1 : 0 },
            })),
        };
      },
      call: (_type: string, callId: string) => ({
        get: async () => {
          await guard();
          const call = fakeStream.calls.get(callId);
          if (!call)
            throw Object.assign(new Error("not found"), { status: 404 });
          const answer = { call: callResponse(callId, call) };
          fakeStream.gets++;
          if (fakeStream.getGate) await fakeStream.getGate;
          return answer;
        },
        queryCallParticipantSessions: async (req: { session: string }) => {
          await guard();
          const session = fakeStream.calls
            .get(callId)
            ?.sessions.find((s) => s.id === req.session);
          const stays = session?.stays ?? [];
          return {
            participants_sessions: stays.map((s) => ({
              user_id: s.userId,
              user_session_id: s.userSessionId,
              joined_at: s.joinedAt.toISOString(),
              ...(s.leftAt ? { left_at: s.leftAt.toISOString() } : {}),
            })),
            total_participant_sessions: stays.length,
            session: session?.live
              ? {}
              : { ended_at: session ? endedAtOf(session) : ENDED_AT },
          };
        },
      }),
    },
  }),
};
