/**
 * @jest-environment node
 */

/** Reopen creates the fresh Stream call first; the Meeting rotates only once that call exists. */

const mockGetOrCreate = jest.fn();
const mockMeetingUpdateMany = jest.fn();
const mockCallIds: string[] = [];

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: { id: "user-host" } } }),
}));
jest.mock("../../lib/rate-limit", () => ({
  meetingControlLimiter: {},
  applyRateLimit: async () => null,
}));
jest.mock("../../lib/meetings/access", () => ({
  hasStreamConsent: async () => true,
}));
jest.mock("../../lib/meetings/route-guard", () => ({
  meetingIdParamSchema: {
    safeParse: (v: string) => ({ success: true, data: v }),
  },
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: async () => ({}),
}));
jest.mock("../../lib/meetings/call-provisioning", () => ({
  STREAM_SERVER_TRUSTED: Symbol.for("familiarise.stream.serverTrusted"),
  readSlotForCaller: async () => ({ slot: { id: "slot-1" } }),
  buildRoomCallPlan: async (
    _authorized: unknown,
    extension: { extendedSeconds: number },
  ) => ({
    authorUserId: "user-host",
    payload: {
      data: {
        created_by_id: "user-host",
        settings_override: { limits: { max_duration_seconds: 6300 } },
        members: [{ user_id: "user-learner", role: "call_member" }],
        custom: { extendedSeconds: extension.extendedSeconds },
      },
    },
  }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: async () => ({ consultantProfileId: "cp-host" }) },
    collaborator: { findFirst: async () => null },
    meeting: {
      findUnique: async () => ({
        id: "ms-1",
        streamCallId: "occurrence-slot-1",
        endedAt: new Date(Date.now() - 2 * 60_000),
        endedReason: "call_ended",
        extendedSeconds: 900,
        extensionsUsed: 1,
        occurrence: {
          id: "slot-1",
          startsAt: new Date(Date.now() - 40 * 60_000),
          endsAt: new Date(Date.now() + 20 * 60_000),
          completionStatus: "SCHEDULED",
          deletedAt: null,
          consultantProfileId: "cp-host",
          appointment: {
            id: "appt-1",
            appointmentType: "CONSULTATION",
            deletedAt: null,
            consultation: {
              status: "APPROVED",
              consultationPlan: { consultantProfileId: "cp-host" },
            },
            subscription: null,
            webinar: null,
            class: null,
            trial: null,
          },
        },
      }),
      updateMany: (...a: unknown[]) => mockMeetingUpdateMany(...a),
    },
  },
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: () => ({
    video: {
      call: (_type: string, id: string) => {
        mockCallIds.push(id);
        return { getOrCreate: (...a: unknown[]) => mockGetOrCreate(...a) };
      },
    },
  }),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { POST as reopenPOST } from "../../app/api/meetings/[meetingId]/reopen/route";

const reopen = () =>
  reopenPOST({} as never, {
    params: Promise.resolve({ meetingId: "occurrence-slot-1" }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockCallIds.length = 0;
  mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
  mockGetOrCreate.mockResolvedValue({});
});

describe("POST /api/meetings/[meetingId]/reopen", () => {
  it("rotates nothing when the Stream call cannot be created", async () => {
    mockGetOrCreate.mockRejectedValueOnce(new Error("stream down"));

    const res = await reopen();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockMeetingUpdateMany).not.toHaveBeenCalled();
  });

  it("creates the call with the provisioner's payload, then CAS-rotates onto that same id", async () => {
    const res = await reopen();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reopened).toBe(true);
    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: [{ user_id: "user-learner", role: "call_member" }],
          custom: { extendedSeconds: 900 },
        }),
      }),
    );
    expect(mockCallIds).toEqual([body.streamCallId]);
    expect(mockMeetingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "ms-1",
          streamCallId: "occurrence-slot-1",
        }),
        data: expect.objectContaining({ streamCallId: body.streamCallId }),
      }),
    );
    expect(mockGetOrCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockMeetingUpdateMany.mock.invocationCallOrder[0],
    );
  });
});
