/**
 * @jest-environment node
 */

/**
 * The booked end is immutable: an extension lives on Meeting, one CAS grants it,
 * and Stream is a mirror that a retry converges instead of adding time to.
 */

const MIN = 60_000;
// One clock read: two would let the booked hour run a millisecond long, which the cap rounds up to a second.
const NOW = Date.now();
const BOOKED_START = new Date(NOW - 55 * MIN);
const BOOKED_END = new Date(NOW + 5 * MIN);

type Store = {
  meeting: {
    id: string;
    streamCallId: string;
    endedAt: Date | null;
    extendedSeconds: number;
    extensionsUsed: number;
  };
  occurrence: Record<string, unknown> & { endsAt: Date };
  stream: { cap: number; custom: Record<string, unknown>; updates: number };
};

const mockStore: Store = {} as Store;
const mockStreamUpdate = jest.fn();
const mockExtendSlotInterval = jest.fn();
const mockUnlockSlotInterval = jest.fn();

function resetStore() {
  mockStore.meeting = {
    id: "ms-1",
    streamCallId: "occurrence-slot-1",
    endedAt: null,
    extendedSeconds: 0,
    extensionsUsed: 0,
  };
  mockStore.occurrence = {
    id: "slot-1",
    appointmentId: "appt-1",
    startsAt: BOOKED_START,
    endsAt: BOOKED_END,
    completionStatus: "SCHEDULED",
    outcome: null,
    deletedAt: null,
    consultantProfileId: "cp-host",
    appointment: {
      participants: [{ userId: "learner" }],
      webinar: null,
      class: null,
    },
  };
  mockStore.stream = {
    cap: 6300,
    custom: { title: "Consultation" },
    updates: 0,
  };
}

jest.mock("../../lib/meetings/route-guard", () => ({
  guardMeetingRoute: async () => ({
    ok: true,
    userId: "host",
    meetingId: "occurrence-slot-1",
    access: {
      role: "host",
      meetingId: "ms-1",
      streamCallId: "occurrence-slot-1",
      appointment: {
        appointmentType: "CONSULTATION",
        consultation: { consultationPlan: { consultantProfileId: "cp-host" } },
      },
    },
  }),
}));

jest.mock("../../lib/rate-limit", () => ({
  meetingControlLimiter: {},
  applyRateLimit: async () => null,
}));

jest.mock("../../lib/prisma", () => {
  type Where = {
    extensionsUsed?: { equals?: number; lt?: number };
    endedAt?: null;
  };
  type Data = {
    extendedSeconds?: { increment: number };
    extensionsUsed?: { increment: number };
  };
  const client: Record<string, unknown> = {
    platformVideoConfig: { findUnique: async () => null },
    meeting: {
      findUnique: async () => ({
        ...mockStore.meeting,
        occurrence: { ...mockStore.occurrence },
      }),
      // One synchronous check-and-set after a yield, like a row lock under READ COMMITTED.
      updateMany: async ({ where, data }: { where: Where; data: Data }) => {
        await Promise.resolve();
        const m = mockStore.meeting;
        const used = where.extensionsUsed;
        const matches =
          m.endedAt === null &&
          (used?.equals === undefined || m.extensionsUsed === used.equals) &&
          (used?.lt === undefined || m.extensionsUsed < used.lt);
        if (!matches) return { count: 0 };
        m.extendedSeconds += data.extendedSeconds?.increment ?? 0;
        m.extensionsUsed += data.extensionsUsed?.increment ?? 0;
        return { count: 1 };
      },
    },
    appointmentOccurrence: {
      findFirst: async () => null,
      updateMany: async ({ data }: { data: { endsAt: Date } }) => {
        mockStore.occurrence.endsAt = data.endsAt;
        return { count: 1 };
      },
    },
  };
  client.$transaction = (fn: (tx: typeof client) => unknown) => fn(client);
  return { __esModule: true, default: client };
});

jest.mock("../../lib/stream-client", () => ({
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: () => ({
    video: {
      call: () => ({
        get: async () => ({
          call: {
            settings: {
              limits: { max_duration_seconds: mockStore.stream.cap },
            },
            custom: { ...mockStore.stream.custom },
          },
        }),
        update: async (body: {
          settings_override: { limits: { max_duration_seconds: number } };
          custom: Record<string, unknown>;
        }) => {
          await mockStreamUpdate(body);
          mockStore.stream.cap =
            body.settings_override.limits.max_duration_seconds;
          mockStore.stream.custom = body.custom;
          mockStore.stream.updates += 1;
        },
      }),
    },
  }),
}));

jest.mock("../../utils/appointmentlock", () => {
  const actual = jest.requireActual("../../utils/appointmentlock");
  return {
    ...actual,
    extendSlotInterval: (...a: unknown[]) => mockExtendSlotInterval(...a),
    unlockSlotInterval: (...a: unknown[]) => mockUnlockSlotInterval(...a),
  };
});

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { POST as extendPOST } from "../../app/api/meetings/[meetingId]/extend/route";
import { classifySessionOutcome } from "../../lib/booking/session-outcome";
import { getMockRedis } from "../../lib/redis-mock";
import { tryLockSlotBatch } from "../../utils/appointmentlock";

const extend = () =>
  extendPOST({} as never, {
    params: Promise.resolve({ meetingId: "occurrence-slot-1" }),
  });

beforeEach(() => {
  resetStore();
  mockStreamUpdate.mockReset();
  const locks = jest.requireActual("../../utils/appointmentlock");
  mockExtendSlotInterval
    .mockReset()
    .mockImplementation(locks.extendSlotInterval);
  mockUnlockSlotInterval
    .mockReset()
    .mockImplementation(locks.unlockSlotInterval);
  getMockRedis().clear();
});

const extraMinutes = () => [
  {
    consultantProfileId: "cp-host",
    startsAt: BOOKED_END,
    endsAt: new Date(BOOKED_END.getTime() + 15 * MIN),
  },
];

describe("POST /api/meetings/[meetingId]/extend — immutable booked end", () => {
  it("leaves the booked end alone, so a session that ends on time after an extension is delivered", async () => {
    expect((await extend()).status).toBe(200);
    expect(mockStore.occurrence.endsAt).toEqual(BOOKED_END);
    expect(mockStore.meeting).toMatchObject({
      extendedSeconds: 900,
      extensionsUsed: 1,
    });
    expect(mockStore.stream.cap).toBe(7200);

    const verdict = classifySessionOutcome({
      startsAt: BOOKED_START,
      endsAt: mockStore.occurrence.endsAt,
      hostUserIds: ["host"],
      intervals: [
        { userId: "host", joinedAt: BOOKED_START, leftAt: BOOKED_END },
        { userId: "learner", joinedAt: BOOKED_START, leftAt: BOOKED_END },
      ],
      meeting: {
        endedAt: new Date(BOOKED_END.getTime() + MIN),
        endedReason: "session_timeout",
      },
      maintenanceWindows: [],
    });
    expect(verdict).toMatchObject({ outcome: "HELD", lostMinutes: 0 });
  });

  it("grants exactly one extension to two concurrent requests", async () => {
    const statuses = (await Promise.all([extend(), extend()]))
      .map((r) => r.status)
      .sort();

    expect(statuses).toEqual([200, 409]);
    expect(mockStore.meeting.extensionsUsed).toBe(1);
    expect(mockStore.meeting.extendedSeconds).toBe(900);
    expect(mockStore.stream.updates).toBe(1);
  });

  it("keeps Postgres as the truth when Stream fails, and a retry finishes the mirror without adding time", async () => {
    mockStreamUpdate.mockRejectedValueOnce(new Error("stream write failed"));

    const failed = await extend();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "EXTEND_SYNC_PENDING" });
    expect(mockStore.meeting.extendedSeconds).toBe(900);
    expect(mockStore.stream.cap).toBe(6300);

    expect((await extend()).status).toBe(200);
    expect(mockStore.stream.cap).toBe(7200);
    expect(mockStore.meeting.extendedSeconds).toBe(900);

    const again = await extend();
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ alreadyExtended: true });
    expect(mockStore.stream.cap).toBe(7200);
  });

  it("keeps the extra minutes' host atoms held, so no booking lands in them", async () => {
    expect((await extend()).status).toBe(200);

    const booking = await tryLockSlotBatch(extraMinutes());
    expect(booking.ok).toBe(false);
  });

  it("refuses before saving anything when the extra minutes' atoms cannot be retained", async () => {
    mockExtendSlotInterval.mockResolvedValueOnce(false);

    const res = await extend();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      extended: false,
      code: "SESSION_NOT_EXTENDABLE",
    });
    expect(mockStore.meeting).toMatchObject({
      extendedSeconds: 0,
      extensionsUsed: 0,
    });
    expect(mockStore.stream.updates).toBe(0);
    expect(mockStreamUpdate).not.toHaveBeenCalled();
    expect(mockUnlockSlotInterval).toHaveBeenCalledTimes(1);
    expect((await tryLockSlotBatch(extraMinutes())).ok).toBe(true);
  });

  it("releases the retained atoms when another request already claimed the extension", async () => {
    mockStore.meeting.extensionsUsed = 1;
    mockStore.meeting.extendedSeconds = 900;
    const meetingRead = {
      ...mockStore.meeting,
      extensionsUsed: 0,
      extendedSeconds: 0,
    };
    const prisma = jest.requireMock("../../lib/prisma").default as {
      meeting: { findUnique: () => Promise<unknown> };
    };
    const realFindUnique = prisma.meeting.findUnique;
    let reads = 0;
    prisma.meeting.findUnique = async () => {
      reads += 1;
      // The first read predates the winning claim; the post-loss read sees it.
      return reads === 1
        ? { ...meetingRead, occurrence: { ...mockStore.occurrence } }
        : realFindUnique();
    };
    try {
      const res = await extend();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ alreadyExtended: true });
    } finally {
      prisma.meeting.findUnique = realFindUnique;
    }

    expect(mockExtendSlotInterval).toHaveBeenCalledTimes(1);
    expect(mockUnlockSlotInterval).toHaveBeenCalledTimes(1);
    expect(mockStore.stream.updates).toBe(0);
    expect((await tryLockSlotBatch(extraMinutes())).ok).toBe(true);
  });
});
