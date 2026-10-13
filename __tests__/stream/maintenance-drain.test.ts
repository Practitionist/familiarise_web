/**
 * @jest-environment node
 */

const mockFindMany = jest.fn();
const mockTransaction = jest.fn();
const mockCallEnd = jest.fn();
const mockUpdatePartial = jest.fn();
const mockGetEventChannelIds = jest.fn();
const mockStopRecording = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      update: jest.fn((args: unknown) => args),
    },
    appointmentOccurrence: { update: jest.fn((args: unknown) => args) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: () => ({
      updatePartial: (...a: unknown[]) => mockUpdatePartial(...a),
    }),
  }),
  getStreamVideoClient: () => ({
    video: { call: () => ({ end: (...a: unknown[]) => mockCallEnd(...a) }) },
  }),
  withStreamCircuitBreaker: async (op: () => unknown) => op(),
}));

jest.mock("../../lib/stream/appointment-channels", () => ({
  getEventChannelIdsForAppointment: (...a: unknown[]) =>
    mockGetEventChannelIds(...a),
}));

jest.mock("../../lib/stream/recording-service", () => ({
  RecordingService: class {
    stopRecording = (...a: unknown[]) => mockStopRecording(...a);
  },
}));

jest.mock("../../lib/novu/service", () => ({
  notifyMaintenanceStarted: jest.fn(async () => undefined),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { warn: jest.fn(), info: jest.fn(), fmt: (s: unknown) => s },
}));

jest.mock("../../lib/stream/batch", () => ({
  ...jest.requireActual("../../lib/stream/batch"),
  pause: jest.fn(async () => undefined),
}));

import {
  drainActiveSessions,
  unfreezeChannelsAfterMaintenance,
} from "../../actions/maintenance/drain-sessions";

function session(id: string, appointmentId: string) {
  return {
    id,
    streamCallId: `slot-${id}`,
    appointmentOccurrenceId: `slot-row-${id}`,
    isRecording: false,
    occurrence: {
      appointmentId,
      appointment: { participants: [{ userId: `u-${id}` }] },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallEnd.mockResolvedValue(undefined);
  mockTransaction.mockResolvedValue(undefined);
  mockUpdatePartial.mockResolvedValue(undefined);
  mockGetEventChannelIds.mockResolvedValue([]);
  mockFindMany.mockResolvedValue([]);
});

describe("drainActiveSessions", () => {
  it("continues the drain and freezes chat after a failed DB write", async () => {
    mockFindMany.mockResolvedValue([
      session("a", "appt-1"),
      session("b", "appt-2"),
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1"]);
    mockTransaction
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce(undefined);

    const result = await drainActiveSessions();

    expect(mockCallEnd).toHaveBeenCalledTimes(2);
    expect(result.drained).toBe(1);
    expect(result.errors.some((e) => e.includes("deadlock"))).toBe(true);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: true } });
  });

  it("records errors for channels Stream refused to freeze without failing the drain", async () => {
    mockFindMany.mockResolvedValue([session("a", "appt-1")]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1", "class-2"]);
    mockUpdatePartial
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stream 500"));

    const result = await drainActiveSessions();

    expect(result.drained).toBe(1);
    expect(result.errors.some((e) => e.includes("freeze class-2"))).toBe(true);
  });
});

describe("unfreezeChannelsAfterMaintenance", () => {
  it("unfreezes channels derived from maintenance-ended meetings", async () => {
    mockFindMany.mockResolvedValue([
      { occurrence: { appointmentId: "appt-1" } },
      { occurrence: { appointmentId: "appt-2" } },
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1", "class-2"]);

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.source).toBe("derived");
    expect(result.unfrozen).toBe(2);
    expect(result.errors).toEqual([]);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: false } });
  });

  it("returns source 'none' when no maintenance-drained sessions exist", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.source).toBe("none");
    expect(result.unfrozen).toBe(0);
    expect(mockUpdatePartial).not.toHaveBeenCalled();
  });

  it("counts only channels Stream confirmed unfrozen and reports partial failures", async () => {
    mockFindMany.mockResolvedValue([
      { occurrence: { appointmentId: "appt-1" } },
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1", "class-2"]);
    mockUpdatePartial
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stream 500"));

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.source).toBe("derived");
    expect(result.unfrozen).toBe(1);
    expect(result.errors.some((e) => e.includes("unfreeze class-2"))).toBe(
      true,
    );
  });
});
