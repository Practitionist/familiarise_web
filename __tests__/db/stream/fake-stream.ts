/**
 * A stand-in for Stream's video API for the database tier: the calls an
 * occurrence lists, each call's sessions and each session's device stays.
 * `jest.mock("../../../lib/stream-client", () => require("./fake-stream").fakeStreamClient)`.
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
}

export const fakeStream = {
  /** Call id to its sessions; a call listed here is returned for its occurrence. */
  calls: new Map<string, { occurrenceId: string; sessions: FakeSession[] }>(),
  /** When set, every request fails with this HTTP status. */
  failStatus: null as number | null,
  requests: 0,
  reset() {
    this.calls.clear();
    this.failStatus = null;
    this.requests = 0;
  },
};

function guard() {
  fakeStream.requests++;
  if (fakeStream.failStatus !== null) {
    throw Object.assign(new Error("fake Stream failure"), {
      status: fakeStream.failStatus,
    });
  }
}

const ENDED_AT = "2026-01-01T00:00:00.000Z";

export const fakeStreamClient = {
  isStreamConfigured: () => true,
  withStreamCircuitBreaker: <T>(op: () => Promise<T>) => op(),
  streamHttpStatus: (e: { status?: number }) => e?.status ?? null,
  getStreamVideoClient: () => ({
    video: {
      queryCalls: async (req: {
        filter_conditions: { "custom.occurrenceId": { $eq: string } };
      }) => {
        guard();
        const occurrenceId = req.filter_conditions["custom.occurrenceId"].$eq;
        return {
          calls: [...fakeStream.calls]
            .filter(([, c]) => c.occurrenceId === occurrenceId)
            .map(([id]) => ({ call: { id, type: "default" } })),
        };
      },
      queryCallSessionStats: async (req: {
        filter_conditions: { call_cid: { $eq: string } };
      }) => {
        guard();
        const callId = req.filter_conditions.call_cid.$eq.replace(
          /^default:/,
          "",
        );
        return {
          call_stats: (fakeStream.calls.get(callId)?.sessions ?? []).map(
            (s) => ({
              call_session_id: s.id,
              ...(s.live ? {} : { call_ended_at: ENDED_AT }),
              counts: { live_sessions: s.live ? 1 : 0 },
            }),
          ),
        };
      },
      call: (_type: string, callId: string) => ({
        queryCallParticipantSessions: async (req: { session: string }) => {
          guard();
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
            session: session?.live ? {} : { ended_at: ENDED_AT },
          };
        },
      }),
    },
  }),
};
