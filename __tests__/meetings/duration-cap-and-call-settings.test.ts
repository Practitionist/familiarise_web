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
const mockMeetingFindFirst = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockParticipantFindMany = jest.fn();
const mockAppointmentFindUnique = jest.fn();
const mockVideoConfigFindUnique = jest.fn();
const configuredQuality = {
  callTargetResolution: "1080p",
  recordingQuality: "1080p",
  screenshareTargetResolution: "720p",
};
const configuredSettings = {
  video: expect.objectContaining({
    target_resolution: { width: 1920, height: 1080, bitrate: 3000000 },
  }),
  screensharing: {
    target_resolution: { width: 1280, height: 720, bitrate: 1500000 },
  },
  recording: { mode: "available", quality: "1080p" },
};

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
        return {
          getOrCreate: (...a: unknown[]) => mockGetOrCreate(...a),
          updateCallMembers: (payload: unknown) =>
            mockUpdateCallMembers(id, payload),
        };
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
      findFirst: (...a: unknown[]) => mockMeetingFindFirst(...a),
      create: (...a: unknown[]) => mockMeetingCreate(...a),
    },
    appointmentParticipant: {
      findMany: (...a: unknown[]) => mockParticipantFindMany(...a),
    },
    platformVideoConfig: {
      findUnique: (...a: unknown[]) => mockVideoConfigFindUnique(...a),
    },
  },
}));

const mockSettleLapsed = jest.fn(async (_occurrenceId: string) => false);
jest.mock("../../lib/booking/reschedule-lapse", () => ({
  settleLapsedProposalForOccurrence: (occurrenceId: string) =>
    mockSettleLapsed(occurrenceId),
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
import { DEFAULT_VIDEO_CONFIG } from "../../lib/stream/video-quality";
import { provisionAppointmentMeeting } from "../../actions/stream/meetings/meeting.action";

beforeEach(() => {
  jest.clearAllMocks();
  mockCallIds.length = 0;
  mockVideoConfigFindUnique.mockResolvedValue(null);
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
  const build = (appointmentType: string, maxDurationSeconds: number | null) =>
    buildCallSettingsOverride(
      appointmentType,
      maxDurationSeconds,
      undefined,
      DEFAULT_VIDEO_CONFIG,
    );
  const qualitySettings = {
    screensharing: {
      target_resolution: { width: 1920, height: 1080, bitrate: 3000000 },
    },
    recording: { mode: "available", quality: "720p" },
  };
  const targetResolution720 = { width: 1280, height: 720, bitrate: 1500000 };

  it("gives 1:1 session types the configured video quality and limits.max_duration_seconds only when set", () => {
    const pairSettings = {
      video: {
        enabled: true,
        camera_default_on: true,
        camera_facing: "front",
        access_request_enabled: true,
        target_resolution: targetResolution720,
      },
      ...qualitySettings,
    };
    for (const appointmentType of ["CONSULTATION", "SUBSCRIPTION", "TRIAL"]) {
      expect(build(appointmentType, 4500)).toEqual({
        ...pairSettings,
        limits: { max_duration_seconds: 4500 },
      });
      expect(build(appointmentType, null)).toEqual(pairSettings);
    }
  });

  it("enables backstage and complete muted access-request stage settings for WEBINAR and CLASS (#2010)", () => {
    const expectedOneToManySettings = {
      backstage: {
        enabled: true,
        join_ahead_time_seconds: 900,
      },
      audio: {
        mic_default_on: false,
        speaker_default_on: true,
        default_device: "speaker",
        access_request_enabled: true,
        opus_dtx_enabled: true,
        redundant_coding_enabled: true,
      },
      video: {
        enabled: true,
        camera_default_on: false,
        camera_facing: "front",
        access_request_enabled: true,
        target_resolution: targetResolution720,
      },
      ...qualitySettings,
    };

    for (const appointmentType of ["WEBINAR", "CLASS"]) {
      expect(build(appointmentType, 4500)).toEqual({
        ...expectedOneToManySettings,
        limits: { max_duration_seconds: 4500 },
      });
      expect(build(appointmentType, null)).toEqual(expectedOneToManySettings);
    }
  });

  it("carries staff-chosen quality into 1:1 and 1:N payloads", () => {
    const chosen = {
      callTargetResolution: "1080p",
      recordingQuality: "1080p",
      screenshareTargetResolution: "720p",
    } as const;
    for (const appointmentType of ["CONSULTATION", "WEBINAR"]) {
      expect(
        buildCallSettingsOverride(appointmentType, null, undefined, chosen),
      ).toMatchObject({
        video: {
          target_resolution: { width: 1920, height: 1080, bitrate: 3000000 },
        },
        screensharing: { target_resolution: targetResolution720 },
        recording: { quality: "1080p" },
      });
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
    mockVideoConfigFindUnique.mockResolvedValue(configuredQuality);

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
            ...configuredSettings,
            limits: { max_duration_seconds: 4500, max_participants: 6 },
          }),
        }),
      }),
    );
  });

  it("opens the original session once an unanswered move has lapsed, with nothing else called", async () => {
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
    const slot = (released: boolean) => ({
      id: "slot-1",
      startsAt,
      endsAt,
      isTentative: released,
      completionStatus: released ? "RESCHEDULED" : "SCHEDULED",
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
    let lapsed = false;
    mockSlotFindUnique.mockImplementation(async () => slot(!lapsed));
    mockSettleLapsed.mockImplementation(async () => {
      lapsed = true;
      return true;
    });
    mockParticipantFindMany.mockResolvedValue([]);
    mockUpsertUsersToStream.mockResolvedValue({ droppedIds: [] });
    mockGetOrCreate.mockResolvedValue({});

    const res = await provisionAppointmentMeeting({ id: "slot-1" });

    expect(mockSettleLapsed).toHaveBeenCalledWith("slot-1");
    expect(res).toEqual({ ok: true, streamCallId: "occurrence-slot-1" });
  });

  it("takes the new members back out of a room whose Meeting row could not be saved", async () => {
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
    mockGetSession.mockResolvedValue({
      user: {
        id: "host-1",
        role: "CONSULTANT",
        consultantProfileId: "cp-host",
      },
    });
    mockMeetingFindUnique.mockResolvedValue(null);
    mockMeetingFindFirst.mockResolvedValue(null);
    mockAppointmentFindUnique.mockResolvedValue({ organizationId: null });
    mockMeetingCreate.mockRejectedValue(new Error("db down"));
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
      { user: { id: "client-1", name: "Client" } },
    ]);
    mockUpsertUsersToStream.mockResolvedValue({ droppedIds: [] });
    mockGetOrCreate.mockResolvedValue({});
    mockUpdateCallMembers.mockResolvedValue({});

    await expect(
      provisionAppointmentMeeting({
        id: "slot-1",
        startsAt,
        endsAt,
        isTentative: false,
        appointmentId: "appt-1",
      }),
    ).rejects.toThrow("db down");

    expect(mockMeetingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { streamCallId: "occurrence-slot-1" } }),
    );
    expect(mockUpdateCallMembers).toHaveBeenCalledWith("occurrence-slot-1", {
      remove_members: ["host-1", "client-1"],
    });
  });

  it("caps a webinar room at the instance override plus headroom, excluding owner and presenter roles", async () => {
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
    mockMeetingFindUnique.mockResolvedValue(null);
    mockAppointmentFindUnique.mockResolvedValue({ organizationId: null });
    mockMeetingCreate.mockResolvedValue({ id: "m", streamCallId: "c" });
    mockSlotFindUnique.mockResolvedValue({
      id: "slot-w",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      appointmentId: "appt-w",
      consultantProfileId: "cp-host",
      appointment: {
        appointmentType: "WEBINAR",
        organizationId: null,
        deletedAt: null,
        participants: [],
        consultation: null,
        subscription: null,
        class: null,
        trial: null,
        webinar: {
          maxParticipants: 150,
          webinarPlan: {
            maxParticipants: 100,
            title: "Launch webinar",
            collaborators: [],
            consultantProfile: {
              id: "cp-host",
              userId: "host-1",
              user: { name: "Host" },
            },
          },
        },
      },
    });
    mockUpsertUsersToStream.mockResolvedValue({ droppedIds: [] });
    mockGetOrCreate.mockResolvedValue({});
    mockVideoConfigFindUnique.mockResolvedValue(configuredQuality);

    await provisionAppointmentMeeting({
      id: "slot-w",
      startsAt,
      endsAt,
      isTentative: false,
      appointmentId: "appt-w",
    });

    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings_override: expect.objectContaining({
            ...configuredSettings,
            limits: {
              max_duration_seconds: 6300,
              max_participants: 155,
              max_participants_exclude_owner: true,
              max_participants_exclude_roles: ["co_presenter", "admin"],
            },
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
          status: "SCHEDULED",
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
