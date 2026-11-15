/**
 * @jest-environment node
 */

/**
 * The join route's seat fence after the membership write: a seat check that
 * cannot be read never admits a client, admits the host, and leaves a durable
 * intent that the sweep later drives without ever removing the host.
 */

const mockGuard = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockUpdateUserPermissions = jest.fn();
const mockReport = jest.fn();

jest.mock("../../lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...a: unknown[]) => mockGuard(...a),
}));
jest.mock("../../lib/rate-limit", () => ({ meetingJoinLimiter: {} }));
jest.mock("../../lib/meetings/room-ready", () => ({
  isOneToManyAppointmentType: (t: string | null) =>
    t === "WEBINAR" || t === "CLASS",
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: jest.fn(async () => ({ users: {} })),
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  isExpectedStreamError: () => false,
  streamHttpStatus: () => null,
  streamErrorCode: () => null,
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamChatClient: () => ({
    channel: () => ({ removeMembers: jest.fn(async () => ({})) }),
  }),
  getStreamVideoClient: () => ({
    video: {
      call: (_type: string, id: string) => ({
        updateCallMembers: (payload: unknown) =>
          mockUpdateCallMembers(id, payload),
        queryMembers: jest.fn(async () => ({ members: [] })),
        updateUserPermissions: (payload: unknown) =>
          mockUpdateUserPermissions(payload),
        get: jest.fn(async () => ({ call: {} })),
      }),
    },
  }),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => mockReport(...a),
}));
const mockCaptureThrottled = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: (...a: unknown[]) => mockCaptureThrottled(...a),
}));
jest.mock("../../lib/stream/dm-eligibility", () => ({
  isDmContextEligible: jest.fn(async () => false),
  isDmChannelIdEligible: jest.fn(async () => false),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  isEventParticipant: jest.fn(async () => false),
  removeUsersFromEventChannel: jest.fn(async () => ({ failedUserIds: [] })),
}));

const mockPrisma = {
  appointment: { findUnique: jest.fn() },
  appointmentParticipant: { findMany: jest.fn(async () => []) },
  user: { findMany: jest.fn(async () => []) },
  meeting: {
    findMany: jest.fn(async () => [{ id: "m1", streamCallId: "occurrence-1" }]),
    findFirst: jest.fn(async () => null),
  },
  streamRevocationRetry: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 1 })),
    findMany: jest.fn(async () => []),
  },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));

import { POST } from "../../app/api/meetings/[meetingId]/join/route";
import { redriveAccessRevocation } from "../../lib/stream/access-revocation";

const webinarContext = {
  deletedAt: null,
  organizationId: null,
  occurrences: [{ consultantProfileId: "cp-host" }],
  webinar: {
    id: "w1",
    status: "SCHEDULED",
    webinarPlan: {
      organizationId: null,
      consultantProfile: { userId: "host-1" },
      collaborators: [],
    },
  },
  class: null,
  consultation: null,
  subscription: null,
  trial: null,
};

function admit(userId: string, role: "host" | "participant") {
  mockGuard.mockResolvedValue({
    ok: true,
    userId,
    meetingId: "m1",
    access: {
      hasAccess: true,
      role,
      streamCallId: "occurrence-1",
      appointment: { id: "appt-1", appointmentType: "WEBINAR" },
      occurrence: { id: "occ-1" },
    },
  });
}

const join = () =>
  POST({} as never, { params: Promise.resolve({ meetingId: "m1" }) });

const removals = () =>
  mockUpdateCallMembers.mock.calls.filter(
    ([, payload]) => (payload as { remove_members?: unknown }).remove_members,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateCallMembers.mockResolvedValue({});
  mockUpdateUserPermissions.mockResolvedValue({});
  // The grant lands, then the database fails the post-write seat check.
  mockPrisma.appointment.findUnique.mockRejectedValueOnce(
    new Error("connection reset"),
  );
});

describe("join when the post-grant seat check fails", () => {
  it("refuses a participant with a retryable 503 and persists the grant for the sweep", async () => {
    admit("attendee-1", "participant");

    const res = await join();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "We could not confirm your booking. Please try again.",
      code: "SEAT_UNVERIFIED",
    });
    expect(mockPrisma.streamRevocationRetry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "SEAT_ACCESS_REVOKE",
            userId: "attendee-1",
            planId: "appt-1",
          }),
        ],
      }),
    );
    expect(mockCaptureThrottled).toHaveBeenCalledTimes(1);
    expect(mockCaptureThrottled).toHaveBeenCalledWith(
      "stream.seat.fenceGrant",
      expect.any(Error),
      expect.objectContaining({ op: "seat.fenceGrant" }),
    );
  });

  it("admits the host, and the sweep's later drive of the intent never removes them", async () => {
    admit("host-1", "host");

    const res = await join();

    expect(res.status).toBe(200);
    expect(mockPrisma.streamRevocationRetry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ userId: "host-1" })],
      }),
    );

    mockPrisma.appointment.findUnique.mockResolvedValue(webinarContext);
    await expect(
      redriveAccessRevocation({
        kind: "SEAT_ACCESS_REVOKE",
        userId: "host-1",
        planId: "appt-1",
        planType: null,
        counterpartUserId: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeNull();
    expect(removals()).toHaveLength(0);
  });

  it("still takes the room back once the sweep reads a lapsed client seat", async () => {
    admit("attendee-1", "participant");
    await join();

    mockPrisma.appointment.findUnique.mockResolvedValue(webinarContext);
    await expect(
      redriveAccessRevocation({
        kind: "SEAT_ACCESS_REVOKE",
        userId: "attendee-1",
        planId: "appt-1",
        planType: null,
        counterpartUserId: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeNull();
    expect(removals()).toEqual([
      ["occurrence-1", { remove_members: ["attendee-1"] }],
    ]);
  });
  it("fences the landed membership when a later Stream write in the join throws", async () => {
    admit("attendee-1", "participant");
    mockUpdateUserPermissions.mockRejectedValueOnce(new Error("timeout"));

    const res = await join();

    expect(res.status).toBe(500);
    expect(mockUpdateCallMembers).toHaveBeenCalledWith("occurrence-1", {
      update_members: [{ user_id: "attendee-1", role: "call_member" }],
    });
    // The seat check could not be read, so the grant is left to the sweep as a durable intent.
    expect(mockPrisma.streamRevocationRetry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "SEAT_ACCESS_REVOKE",
            userId: "attendee-1",
            planId: "appt-1",
          }),
        ],
      }),
    );
  });
});
