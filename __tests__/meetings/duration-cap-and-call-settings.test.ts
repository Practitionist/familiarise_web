/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockUpsertUsersToStream = jest.fn();
const mockGetOrCreate = jest.fn();
const mockCallIds: string[] = [];
const mockSlotFindUnique = jest.fn();
const mockMeetingFindUnique = jest.fn();
const mockMeetingCreate = jest.fn();
const mockParticipantFindMany = jest.fn();
const mockAppointmentFindUnique = jest.fn();

jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: jest.fn().mockResolvedValue({ phase: "OFF" }),
}));

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: (...a: unknown[]) => mockUpsertUsersToStream(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      call: (_type: string, id: string) => {
        mockCallIds.push(id);
        return { getOrCreate: (...a: unknown[]) => mockGetOrCreate(...a) };
      },
    },
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findUnique: (...a: unknown[]) => mockSlotFindUnique(...a),
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
    },
    meeting: {
      findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a),
      create: (...a: unknown[]) => mockMeetingCreate(...a),
    },
    appointmentParticipant: {
      findMany: (...a: unknown[]) => mockParticipantFindMany(...a),
    },
  },
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  CALL_DURATION_GRACE_MS,
  MAX_CALL_DURATION_MS,
  MIN_CALL_DURATION_MS,
  resolveMaxCallDurationSeconds,
} from "../../lib/meetings/duration-cap";
import {
  buildCallSettingsOverride,
  isAwaitingHostGoLive,
} from "../../lib/meetings/room-ready";
import { provisionAppointmentMeeting } from "../../actions/stream/meetings/meeting.action";

beforeEach(() => {
  jest.clearAllMocks();
  mockCallIds.length = 0;
});

describe("lib/meetings/duration-cap", () => {
  it("sets MIN_CALL_DURATION_MS to 45 minutes so a 30-minute Trial gets a 75-minute (4500s) cap", () => {
    expect(MIN_CALL_DURATION_MS).toBe(45 * 60 * 1000);
    expect(CALL_DURATION_GRACE_MS).toBe(30 * 60 * 1000);
    expect(MAX_CALL_DURATION_MS).toBe(12 * 60 * 60 * 1000);

    const startsAt = new Date("2026-10-03T10:00:00.000Z");
    const endsAt = new Date("2026-10-03T10:30:00.000Z");

    expect(resolveMaxCallDurationSeconds({ endsAt }, startsAt)).toBe(4500);
  });

  it("computes 105 minutes (6300s) for a 60-minute consultation", () => {
    const startsAt = new Date("2026-10-03T10:00:00.000Z");
    const endsAt = new Date("2026-10-03T11:00:00.000Z");

    expect(resolveMaxCallDurationSeconds({ endsAt }, startsAt)).toBe(6300);
  });
});

describe("buildCallSettingsOverride & isAwaitingHostGoLive", () => {
  it("configures limits.max_duration_seconds for 1:1 session types and returns undefined when null", () => {
    for (const appointmentType of ["CONSULTATION", "SUBSCRIPTION", "TRIAL"]) {
      expect(buildCallSettingsOverride(appointmentType, 4500)).toEqual({
        limits: { max_duration_seconds: 4500 },
      });
      expect(buildCallSettingsOverride(appointmentType, null)).toBeUndefined();
    }
  });

  it("enables backstage and muted access-request stage settings for WEBINAR and CLASS", () => {
    const expectedOneToManySettings = {
      backstage: {
        enabled: true,
        join_ahead_time_seconds: 900,
      },
      audio: {
        mic_default_on: false,
        default_device: "speaker",
        access_request_enabled: true,
      },
      video: {
        camera_default_on: false,
        access_request_enabled: true,
      },
    };

    for (const appointmentType of ["WEBINAR", "CLASS"]) {
      expect(buildCallSettingsOverride(appointmentType, 4500)).toEqual({
        ...expectedOneToManySettings,
        limits: { max_duration_seconds: 4500 },
      });
      expect(buildCallSettingsOverride(appointmentType, null)).toEqual(
        expectedOneToManySettings,
      );
    }
  });

  it("only reports awaiting Go Live when backstage is enabled on a 1-to-Many session", () => {
    expect(
      isAwaitingHostGoLive({
        appointmentType: "WEBINAR",
        isCallLive: false,
        isBackstageEnabled: false,
      }),
    ).toBe(false);
    expect(
      isAwaitingHostGoLive({
        appointmentType: "WEBINAR",
        isCallLive: false,
        isBackstageEnabled: true,
      }),
    ).toBe(true);
    expect(
      isAwaitingHostGoLive({
        appointmentType: "WEBINAR",
        isCallLive: true,
        isBackstageEnabled: true,
      }),
    ).toBe(false);
    expect(
      isAwaitingHostGoLive({
        appointmentType: "CONSULTATION",
        isCallLive: false,
        isBackstageEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("provisionAppointmentMeeting", () => {
  it("retains max_duration_seconds even when a participant lacks Stream consent (droppedIds)", async () => {
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);

    mockGetSession.mockResolvedValue({
      user: {
        id: "host-1",
        role: "CONSULTANT",
        consultantProfileId: "cp-host",
        banned: false,
      },
    });
    mockMeetingFindUnique.mockResolvedValue(null);
    mockAppointmentFindUnique.mockResolvedValue({ organizationId: null });
    mockMeetingCreate.mockResolvedValue({
      id: "meeting-1",
      streamCallId: "occurrence-slot-1",
    });
    mockSlotFindUnique.mockResolvedValue({
      id: "slot-1",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      appointmentId: "appt-1",
      consultantProfileId: "cp-host",
      appointment: {
        appointmentType: "TRIAL",
        organizationId: null,
        deletedAt: null,
        participants: [],
        consultation: null,
        subscription: null,
        webinar: null,
        class: null,
        trial: {
          status: "SCHEDULED",
          subscriptionPlan: {
            title: "Trial Session",
            consultantProfile: {
              id: "cp-host",
              userId: "host-1",
              user: { name: "Dr. Host" },
            },
          },
        },
      },
    });
    mockParticipantFindMany.mockResolvedValue([
      { user: { id: "consultee-no-consent", name: "Consultee" } },
    ]);
    mockUpsertUsersToStream.mockResolvedValue({
      droppedIds: ["consultee-no-consent"],
    });
    mockGetOrCreate.mockResolvedValue({});

    const res = await provisionAppointmentMeeting({
      id: "slot-1",
      startsAt,
      endsAt,
      isTentative: false,
      appointmentId: "appt-1",
    });

    expect(res).toEqual({ ok: true, streamCallId: "occurrence-slot-1" });
    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: [{ user_id: "host-1", role: "call_member" }],
          settings_override: expect.objectContaining({
            limits: { max_duration_seconds: 4500 },
          }),
        }),
      }),
    );
  });

  it("refuses a stranger before the booking-status refusal and writes nothing", async () => {
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

    mockGetSession.mockResolvedValue({
      user: {
        id: "stranger-1",
        role: "CONSULTEE",
        consultantProfileId: null,
        banned: false,
      },
    });
    mockMeetingFindUnique.mockResolvedValue(null);
    mockSlotFindUnique.mockResolvedValue({
      id: "slot-cancelled",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "CANCELLED",
      deletedAt: null,
      appointmentId: "appt-cancelled",
      consultantProfileId: "cp-host",
      appointment: {
        appointmentType: "CONSULTATION",
        organizationId: null,
        participants: [],
        consultation: {
          status: "CANCELLED",
          consultationPlan: {
            title: "1:1 Consultation",
            consultantProfile: {
              id: "cp-host",
              userId: "host-1",
              user: { name: "Host" },
            },
          },
        },
        subscription: null,
        webinar: null,
        class: null,
        trial: null,
      },
    });

    await expect(
      provisionAppointmentMeeting({
        id: "slot-cancelled",
        startsAt,
        endsAt,
        isTentative: false,
      }),
    ).resolves.toEqual({
      ok: false,
      refusal: "You are not a participant in this session.",
    });
    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockMeetingCreate).not.toHaveBeenCalled();
  });

  it("recreates a missing call for an existing Meeting row with full settings", async () => {
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

    mockGetSession.mockResolvedValue({
      user: {
        id: "host-1",
        role: "CONSULTANT",
        consultantProfileId: "cp-host",
        banned: false,
      },
    });
    mockMeetingFindUnique.mockResolvedValue({
      id: "meeting-seed",
      streamCallId: "seed-room-uuid",
      endedAt: null,
      endedReason: null,
    });
    mockSlotFindUnique.mockResolvedValue({
      id: "slot-2",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      appointmentId: "appt-2",
      consultantProfileId: "cp-host",
      appointment: {
        appointmentType: "WEBINAR",
        organizationId: null,
        deletedAt: null,
        participants: [],
        consultation: null,
        subscription: null,
        webinar: {
          status: "CONFIRMED",
          webinarPlan: {
            title: "Webinar",
            consultantProfile: {
              id: "cp-host",
              userId: "host-1",
              user: { name: "Host" },
            },
            collaborators: [],
          },
        },
        class: null,
        trial: null,
      },
    });
    mockParticipantFindMany.mockResolvedValue([]);
    mockUpsertUsersToStream.mockResolvedValue({});
    mockGetOrCreate.mockResolvedValue({ created: true });

    const res = await provisionAppointmentMeeting({
      id: "slot-2",
      startsAt,
      endsAt,
    });

    expect(res).toEqual({ ok: true, streamCallId: "seed-room-uuid" });
    expect(mockCallIds).toEqual(["seed-room-uuid"]);
    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          created_by_id: "host-1",
          settings_override: expect.objectContaining({
            backstage: expect.objectContaining({ enabled: true }),
          }),
        }),
      }),
    );
    expect(mockMeetingCreate).not.toHaveBeenCalled();
  });
});
