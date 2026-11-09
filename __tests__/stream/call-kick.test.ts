/**
 * @jest-environment node
 */

/**
 * A removed attendee is kicked from the appointment's open calls and blocked
 * from rejoining; a Stream failure is queued as CALL_KICK and re-driven by the
 * moderation retry sweep unless Postgres has since re-admitted the user.
 */
import type { AccessRevocationRow } from "@/lib/stream/access-revocation";

const mockPrisma = {
  appointmentOccurrence: { findMany: jest.fn() },
  appointmentParticipant: { findFirst: jest.fn() },
  streamRevocationRetry: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 1 })),
  },
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockPrisma }));

const mockUpdateCallMembers = jest.fn();
const mockKickUser = jest.fn();
const mockCall = jest.fn((_type: string, _id: string) => ({
  updateCallMembers: mockUpdateCallMembers,
  kickUser: mockKickUser,
}));
jest.mock("@/lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
  getStreamVideoClient: () => ({ video: { call: mockCall } }),
  isExpectedStreamError: (error: { expected?: boolean }) =>
    error?.expected === true,
}));
const mockReport = jest.fn();
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("@/lib/booking/participants", () => ({
  paidParticipant: (userId?: string) => ({ userId, paid: true }),
}));
jest.mock("@/lib/stream/event-channel-service", () => ({
  isEventParticipant: jest.fn(),
  removeUsersFromEventChannel: jest.fn(),
}));
jest.mock("@/lib/stream/dm-eligibility", () => ({
  isDmContextEligible: jest.fn(),
  isDmChannelIdEligible: jest.fn(),
}));

const load = () => import("@/lib/stream/access-revocation");

const openCalls = (...ids: string[]) =>
  mockPrisma.appointmentOccurrence.findMany.mockResolvedValue(
    ids.map((streamCallId) => ({ meeting: { streamCallId } })),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateCallMembers.mockResolvedValue({});
  mockKickUser.mockResolvedValue({});
  openCalls("call-1", "call-2");
});

describe("kickUserFromAppointmentCalls", () => {
  it("removes the member and kicks with a block on every open call", async () => {
    const { kickUserFromAppointmentCalls } = await load();
    await expect(
      kickUserFromAppointmentCalls("appt-1", "attendee-1"),
    ).resolves.toBe(true);
    expect(mockCall).toHaveBeenCalledWith("default", "call-1");
    expect(mockCall).toHaveBeenCalledWith("default", "call-2");
    expect(mockUpdateCallMembers).toHaveBeenCalledTimes(2);
    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      remove_members: ["attendee-1"],
    });
    expect(mockKickUser).toHaveBeenCalledTimes(2);
    expect(mockKickUser).toHaveBeenCalledWith({
      user_id: "attendee-1",
      block: true,
    });
  });

  it("only looks at this appointment's calls that have not ended", async () => {
    const { kickUserFromAppointmentCalls } = await load();
    await kickUserFromAppointmentCalls("appt-1", "attendee-1");
    const where =
      mockPrisma.appointmentOccurrence.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      appointmentId: "appt-1",
      deletedAt: null,
      meeting: { is: { endedAt: null } },
    });
  });

  it("is a success with nothing to do when no call is open", async () => {
    openCalls();
    const { kickUserFromAppointmentCalls } = await load();
    await expect(
      kickUserFromAppointmentCalls("appt-1", "attendee-1"),
    ).resolves.toBe(true);
    expect(mockKickUser).not.toHaveBeenCalled();
  });

  it("treats a user who is already out of the call as done", async () => {
    mockUpdateCallMembers.mockRejectedValue({ expected: true });
    const { kickUserFromAppointmentCalls } = await load();
    await expect(
      kickUserFromAppointmentCalls("appt-1", "attendee-1"),
    ).resolves.toBe(true);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("reports false and pages once when Stream fails on several calls", async () => {
    mockKickUser.mockRejectedValue(new Error("stream 500"));
    const { kickUserFromAppointmentCalls } = await load();
    await expect(
      kickUserFromAppointmentCalls("appt-1", "attendee-1"),
    ).resolves.toBe(false);
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport.mock.calls[0][1]).toMatchObject({
      op: "participantRemoval.kickFromCalls",
      extra: { appointmentId: "appt-1", failed: 2 },
    });
  });

  it("returns false instead of throwing when the lookup fails", async () => {
    mockPrisma.appointmentOccurrence.findMany.mockRejectedValue(
      new Error("db down"),
    );
    const { kickUserFromAppointmentCalls } = await load();
    await expect(
      kickUserFromAppointmentCalls("appt-1", "attendee-1"),
    ).resolves.toBe(false);
  });
});

describe("the CALL_KICK retry", () => {
  it("queues the appointment and user for the sweep", async () => {
    const { enqueueCallKickRetry } = await load();
    await enqueueCallKickRetry("appt-1", "attendee-1");
    expect(mockPrisma.streamRevocationRetry.createMany).toHaveBeenCalledWith({
      data: [
        {
          kind: "CALL_KICK",
          userId: "attendee-1",
          planId: "appt-1",
          planType: null,
          counterpartUserId: null,
        },
      ],
      skipDuplicates: true,
    });
  });

  const row: AccessRevocationRow = {
    kind: "CALL_KICK",
    userId: "attendee-1",
    planId: "appt-1",
    planType: null,
    counterpartUserId: null,
    createdAt: new Date(),
  };

  it("drops the retry when Postgres has re-admitted the user", async () => {
    mockPrisma.appointmentParticipant.findFirst.mockResolvedValue({ id: "s" });
    const { redriveAccessRevocation } = await load();
    await expect(redriveAccessRevocation(row)).resolves.toBeNull();
    expect(mockKickUser).not.toHaveBeenCalled();
  });

  it("kicks again when the user is still out", async () => {
    mockPrisma.appointmentParticipant.findFirst.mockResolvedValue(null);
    const { redriveAccessRevocation } = await load();
    await expect(redriveAccessRevocation(row)).resolves.toBeNull();
    expect(mockKickUser).toHaveBeenCalledTimes(2);
  });

  it("returns the error to record when Stream still refuses", async () => {
    mockPrisma.appointmentParticipant.findFirst.mockResolvedValue(null);
    mockKickUser.mockRejectedValue(new Error("stream 500"));
    const { redriveAccessRevocation } = await load();
    await expect(redriveAccessRevocation(row)).resolves.toBe(
      "Call kick failed",
    );
  });
});
