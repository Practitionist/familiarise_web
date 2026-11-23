/**
 * @jest-environment node
 */

/**
 * Stream's settled participant record is read for every call id and every
 * session of an occurrence, and each failure keeps its own name: a partial,
 * live, expired or unreachable answer is never an empty list.
 */

type Row = {
  user_id: string;
  user_session_id: string;
  joined_at?: string;
  left_at?: string;
};
type Session = {
  call_session_id: string;
  call_ended_at?: string;
  counts: { live_sessions: number; sessions: number; participants: number };
};

const stream = {
  calls: [] as { type: string; id: string }[],
  callsNext: undefined as string | undefined,
  sessions: new Map<string, Session[]>(),
  rows: new Map<string, Row[]>(),
  totals: new Map<string, number>(),
  sessionEnded: true,
  failParticipants: null as null | { status: number },
  /** A cursor the session listing returns on every page. */
  sessionsNext: undefined as string | undefined,
  /** When set, the call listing never answers. */
  stall: false,
};

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  withStreamCircuitBreaker: (op: () => Promise<unknown>) => op(),
  streamHttpStatus: (e: { status?: number }) => e?.status ?? null,
  getStreamVideoClient: () => ({
    video: {
      queryCalls: () =>
        stream.stall
          ? new Promise(() => undefined)
          : Promise.resolve({
              calls: stream.calls.map((call) => ({ call })),
              next: stream.callsNext,
            }),
      queryCallSessionStats: async (req: {
        filter_conditions: { call_cid: { $eq: string } };
      }) => ({
        call_stats:
          stream.sessions.get(req.filter_conditions.call_cid.$eq) ?? [],
        next: stream.sessionsNext,
      }),
      call: (_type: string, callId: string) => ({
        get: async () => ({
          call: { id: callId, type: "default", current_session_id: "" },
        }),
        queryCallParticipantSessions: async (req: { session: string }) => {
          if (stream.failParticipants) throw stream.failParticipants;
          const rows = stream.rows.get(`${callId}/${req.session}`) ?? [];
          return {
            participants_sessions: rows,
            total_participant_sessions:
              stream.totals.get(`${callId}/${req.session}`) ?? rows.length,
            session: stream.sessionEnded
              ? { ended_at: "2026-11-23T05:35:00Z" }
              : {},
          };
        },
      }),
    },
  }),
}));

import { readSettledAttendance } from "../../lib/stream/call-presence";

const ended = (id: string): Session => ({
  call_session_id: id,
  call_ended_at: "2026-11-23T05:35:00Z",
  counts: { live_sessions: 0, sessions: 1, participants: 1 },
});
const stay = (user: string, from: string, to: string): Row => ({
  user_id: user,
  user_session_id: `${user}-${from}`,
  joined_at: `2026-11-23T${from}:00Z`,
  left_at: `2026-11-23T${to}:00Z`,
});

/** Every session's report announced ready, as Stream does once its data is final. */
const READY: {
  readySessionIds: string[];
  lastKnownSessionId: string | null;
  currentCallReserved: boolean;
} = {
  readySessionIds: ["s1", "s2", "s3"],
  lastKnownSessionId: null,
  currentCallReserved: false,
};

const read = (overrides: Partial<typeof READY> = {}) =>
  readSettledAttendance({
    occurrenceId: "occ-1",
    currentCallId: "occurrence-occ-1-r2",
    ...READY,
    ...overrides,
  });

beforeEach(() => {
  stream.calls = [{ type: "default", id: "occurrence-occ-1" }];
  stream.callsNext = undefined;
  stream.sessions = new Map([
    ["default:occurrence-occ-1", [ended("s1"), ended("s2")]],
    ["default:occurrence-occ-1-r2", [ended("s3")]],
  ]);
  stream.rows = new Map([
    ["occurrence-occ-1/s1", [stay("priya", "04:30", "04:50")]],
    ["occurrence-occ-1/s2", [stay("priya", "04:53", "05:29")]],
    ["occurrence-occ-1-r2/s3", [stay("hannah", "04:32", "05:29")]],
  ]);
  stream.totals = new Map();
  stream.sessionEnded = true;
  stream.sessionsNext = undefined;
  stream.stall = false;
  stream.failParticipants = null;
});

it("reads every session of the current call and of each earlier call Stream lists for the occurrence", async () => {
  const answer = await read();
  expect(answer.kind).toBe("read");
  if (answer.kind !== "read") return;
  expect(
    answer.intervals
      .map((i) => [i.userId, i.streamCallId, i.userSessionId])
      .sort(),
  ).toEqual([
    ["hannah", "occurrence-occ-1-r2", "hannah-04:32"],
    ["priya", "occurrence-occ-1", "priya-04:30"],
    ["priya", "occurrence-occ-1", "priya-04:53"],
  ]);
});

it.each([
  [
    "a session still live",
    () => {
      // s2 stays listed, so only s1's liveness can make the record not final.
      stream.sessions.set("default:occurrence-occ-1", [
        {
          ...ended("s1"),
          counts: { live_sessions: 1, sessions: 1, participants: 1 },
        },
        ended("s2"),
      ]);
    },
  ],
  [
    "a session with no end",
    () => {
      // s2 stays listed, so only s1's missing end can make the record not final.
      stream.sessions.set("default:occurrence-occ-1", [
        {
          call_session_id: "s1",
          counts: { live_sessions: 0, sessions: 1, participants: 1 },
        },
        ended("s2"),
      ]);
    },
  ],
  [
    "fewer rows than Stream's total",
    () => stream.totals.set("occurrence-occ-1/s1", 2),
  ],
  [
    "a stay with no leave",
    () =>
      stream.rows.set("occurrence-occ-1/s1", [
        { ...stay("priya", "04:30", "04:50"), left_at: undefined },
      ]),
  ],
  [
    "a participant read whose session has not ended",
    () => {
      stream.sessionEnded = false;
    },
  ],
])("%s is not-final", async (_case, arrange) => {
  arrange();
  expect(await read()).toEqual({ kind: "not-final" });
});

it("an occurrence no call of which ever had a session is no-session, not an empty read", async () => {
  stream.sessions = new Map();
  expect(await read({ readySessionIds: [] })).toEqual({ kind: "no-session" });
});

it.each([
  [1, "not-final"],
  [91, "expired"],
])(
  "a 404 on participant detail for a session that ended %i day(s) ago is %s",
  async (days, kind) => {
    const endedAt = new Date(Date.now() - days * 86_400_000).toISOString();
    stream.sessions = new Map([
      [
        "default:occurrence-occ-1",
        [{ ...ended("s1"), call_ended_at: endedAt }],
      ],
      [
        "default:occurrence-occ-1-r2",
        [{ ...ended("s3"), call_ended_at: endedAt }],
      ],
    ]);
    stream.failParticipants = { status: 404 };
    expect(await read({ readySessionIds: ["s1", "s3"] })).toEqual({ kind });
  },
);

it("a participant read failing with 503 is unavailable", async () => {
  stream.failParticipants = { status: 503 };
  expect(await read()).toEqual({ kind: "unavailable" });
});

it("a call list longer than one page is unavailable, since Stream refuses its cursor", async () => {
  stream.callsNext = "cursor";
  expect(await read()).toEqual({ kind: "unavailable" });
});

it("a session listing whose cursor repeats is not final, never a complete list", async () => {
  stream.sessionsNext = "same-cursor";
  expect(await read()).toEqual({ kind: "not-final" });
});

it("a read past its deadline is unavailable and stops asking Stream", async () => {
  stream.stall = true;
  const started = Date.now();
  expect(
    await readSettledAttendance({
      occurrenceId: "occ-1",
      currentCallId: "occurrence-occ-1-r2",
      ...READY,
      deadlineAt: started + 50,
    }),
  ).toEqual({ kind: "unavailable" });
  expect(Date.now() - started).toBeLessThan(2_000);
});

it("a session whose report is not announced is read only when our webhooks corroborate the list", async () => {
  const unannounced = { readySessionIds: ["s1", "s3"] };
  expect(await read(unannounced)).toEqual({ kind: "not-final" });
  expect((await read({ ...unannounced, lastKnownSessionId: "s2" })).kind).toBe(
    "read",
  );
});

it("a session announced or seen elsewhere that stats do not list keeps the record not final", async () => {
  expect(await read({ lastKnownSessionId: "s9" })).toEqual({
    kind: "not-final",
  });
  expect(
    await read({ readySessionIds: [...READY.readySessionIds, "s9"] }),
  ).toEqual({ kind: "not-final" });
});

it("an expired session whose detail comes back as an empty list, with its total kept, is expired", async () => {
  const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
  stream.sessions = new Map([
    ["default:occurrence-occ-1", [{ ...ended("s1"), call_ended_at: old }]],
    ["default:occurrence-occ-1-r2", [{ ...ended("s3"), call_ended_at: old }]],
  ]);
  stream.rows.set("occurrence-occ-1/s1", []);
  stream.totals.set("occurrence-occ-1/s1", 1);
  stream.rows.set("occurrence-occ-1-r2/s3", []);
  stream.totals.set("occurrence-occ-1-r2/s3", 1);
  expect(await read({ readySessionIds: ["s1", "s3"] })).toEqual({
    kind: "expired",
  });
});
