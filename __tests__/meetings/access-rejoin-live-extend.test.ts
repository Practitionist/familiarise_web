/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockCheckConsent = jest.fn();
const mockUpsertUsersToStream = jest.fn();
const mockGetOrCreate = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockUpdateUserPermissions = jest.fn();
const mockEnd = jest.fn();
const mockGoLive = jest.fn();
const mockCallGet = jest.fn();
const mockCallUpdate = jest.fn();

const mockMeetingFindUnique = jest.fn();
const mockMeetingUpdateMany = jest.fn();
const mockAttendanceUpsert = jest.fn();
const mockPresenceFindFirst = jest.fn();
const mockPresenceCreate = jest.fn();
const mockParticipantFindFirst = jest.fn();
const mockParticipantUpdateMany = jest.fn();
const mockOccurrenceFindFirst = jest.fn();
const mockUserFindUnique = jest.fn();

let sequence: string[] = [];

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

jest.mock("../../lib/compliance/dpdp", () => ({
  checkConsent: (...a: unknown[]) => mockCheckConsent(...a),
}));

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: (...a: unknown[]) => {
    sequence.push("upsertUsersToStream");
    return mockUpsertUsersToStream(...a);
  },
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  StreamUnavailableError: class StreamUnavailableError extends Error {
    constructor() {
      super("Stream is unavailable");
      this.name = "StreamUnavailableError";
    }
  },
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      call: () => ({
        getOrCreate: (...a: unknown[]) => {
          sequence.push("getOrCreate");
          return mockGetOrCreate(...a);
        },
        updateCallMembers: (...a: unknown[]) => {
          sequence.push("updateCallMembers");
          return mockUpdateCallMembers(...a);
        },
        updateUserPermissions: (...a: unknown[]) =>
          mockUpdateUserPermissions(...a),
        end: (...a: unknown[]) => mockEnd(...a),
        goLive: (...a: unknown[]) => mockGoLive(...a),
        get: (...a: unknown[]) => mockCallGet(...a),
        update: (...a: unknown[]) => mockCallUpdate(...a),
      }),
    },
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: { findFirst: jest.fn() },
    meeting: {
      findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a),
      updateMany: (...a: unknown[]) => mockMeetingUpdateMany(...a),
    },
    meetingAttendance: {
      upsert: (...a: unknown[]) => mockAttendanceUpsert(...a),
    },
    meetingPresence: {
      findFirst: (...a: unknown[]) => mockPresenceFindFirst(...a),
      create: (...a: unknown[]) => mockPresenceCreate(...a),
    },
    appointmentParticipant: {
      findFirst: (...a: unknown[]) => mockParticipantFindFirst(...a),
      updateMany: (...a: unknown[]) => mockParticipantUpdateMany(...a),
    },
    appointmentOccurrence: {
      findFirst: (...a: unknown[]) => mockOccurrenceFindFirst(...a),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
    },
    collaborator: {
      findFirst: jest.fn().mockResolvedValue(null),
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

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import {
  getOccurrenceJoinState,
  getOccurrenceVMJoinState,
  REJOIN_GRACE_MS,
} from "../../lib/appointments/occurrences";
import { resolveMeetingAccess } from "../../lib/meetings/access";
import { isInCallChatAllowed } from "../../lib/meetings/room-ready";
import { computeOverrunBannerState } from "../../app/meetings/[id]/components/OverrunBanner";
import { slotStatus } from "../../components/appointments/SessionTimeline";
import { POST as joinPOST } from "../../app/api/meetings/[meetingId]/join/route";
import { POST as endPOST } from "../../app/api/meetings/[meetingId]/end/route";
import { POST as livePOST } from "../../app/api/meetings/[meetingId]/live/route";
import { POST as extendPOST } from "../../app/api/meetings/[meetingId]/extend/route";

const MINUTE = 60 * 1000;

function makeLiveMeetingRow(opts?: {
  endsInMs?: number;
  endedAt?: Date | null;
  endedReason?: string | null;
  hostProfileId?: string;
  appointmentType?: "CONSULTATION" | "WEBINAR" | "CLASS";
}) {
  const now = Date.now();
  const startsAt = new Date(now - 10 * MINUTE);
  const endsAt = new Date(now + (opts?.endsInMs ?? 20 * MINUTE));
  const appointmentType = opts?.appointmentType ?? "CONSULTATION";
  const hostProfileId = opts?.hostProfileId ?? "cp-host";
  return {
    id: "ms-1",
    streamCallId: "occurrence-slot-1",
    appointmentOccurrenceId: "slot-1",
    endedAt: opts?.endedAt ?? null,
    endedReason: opts?.endedReason ?? null,
    occurrence: {
      id: "slot-1",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      consultantProfileId: hostProfileId,
      appointmentId: "appt-1",
      appointment: {
        id: "appt-1",
        appointmentType,
        deletedAt: null,
        consultation:
          appointmentType === "CONSULTATION"
            ? {
                status: "APPROVED",
                consultationPlan: {
                  consultantProfileId: hostProfileId,
                  recordingEnabled: true,
                },
              }
            : null,
        subscription: null,
        webinar:
          appointmentType === "WEBINAR"
            ? {
                status: "SCHEDULED",
                webinarPlan: {
                  id: "wp-1",
                  consultantProfileId: hostProfileId,
                  recordingEnabled: true,
                },
              }
            : null,
        class:
          appointmentType === "CLASS"
            ? {
                status: "SCHEDULED",
                classPlan: {
                  id: "cp-1",
                  consultantProfileId: hostProfileId,
                  recordingEnabled: true,
                },
              }
            : null,
        trial: null,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequence = [];
  mockCheckConsent.mockResolvedValue(true);
  mockGetSession.mockResolvedValue({
    user: { id: "user-host", banned: false },
  });
  mockUserFindUnique.mockResolvedValue({ consultantProfileId: "cp-host" });
  mockParticipantFindFirst.mockResolvedValue({ id: "seat-1" });
  mockMeetingFindUnique.mockResolvedValue(makeLiveMeetingRow());
  mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
  mockAttendanceUpsert.mockResolvedValue({});
  mockPresenceFindFirst.mockResolvedValue(null);
  mockPresenceCreate.mockResolvedValue({});
  mockParticipantUpdateMany.mockResolvedValue({ count: 1 });
  mockUpsertUsersToStream.mockResolvedValue({ users: {} });
  mockGetOrCreate.mockResolvedValue({});
  mockUpdateCallMembers.mockResolvedValue({});
  mockUpdateUserPermissions.mockResolvedValue({});
  mockEnd.mockResolvedValue({});
  mockGoLive.mockResolvedValue({});
  mockOccurrenceFindFirst.mockResolvedValue(null);
  mockCallGet.mockResolvedValue({
    call: {
      settings: { limits: { max_duration_seconds: 6300 } },
      custom: {},
    },
  });
  mockCallUpdate.mockResolvedValue({});
});

describe("DPDP consent gate in resolveMeetingAccess", () => {
  it("refuses meeting access when STREAM_DATA_PROCESSING consent is missing or withdrawn", async () => {
    mockCheckConsent.mockResolvedValue(false);

    const access = await resolveMeetingAccess("occurrence-slot-1", "user-1");

    expect(access).toMatchObject({
      hasAccess: false,
      code: "CONSENT_REQUIRED",
    });
    expect(access.message).toMatch(/consent.*required/i);
  });

  it("grants host access to an occurrence-assigned Enterprise org expert when plan owner differs", async () => {
    const row = makeLiveMeetingRow({ hostProfileId: "cp-plan-owner" });
    row.occurrence.consultantProfileId = "cp-org-expert";
    mockMeetingFindUnique.mockResolvedValue(row);
    mockUserFindUnique.mockResolvedValue({
      consultantProfileId: "cp-org-expert",
    });

    const access = await resolveMeetingAccess(
      "occurrence-slot-1",
      "user-org-expert",
    );
    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("host");
  });
});

describe("Dashboard 30m rejoin grace & mid-slot ended_early reopen", () => {
  it("keeps dashboard Join state joinable for 30 minutes after endsAt unless deliberately ended", () => {
    expect(REJOIN_GRACE_MS).toBe(30 * MINUTE);
    const now = new Date();
    const startsAt = new Date(now.getTime() - 75 * MINUTE);
    const endsAt = new Date(now.getTime() - 15 * MINUTE);

    expect(
      getOccurrenceJoinState(
        {
          id: "occ-1",
          startsAt,
          endsAt,
          isTentative: false,
          completionStatus: "COMPLETED",
          meeting: { id: "mtg-1", endedAt: null, endedReason: null },
        },
        { rejoinGraceMs: REJOIN_GRACE_MS, now },
      ),
    ).toBe("joinable");

    expect(
      getOccurrenceVMJoinState(
        {
          occurrenceId: "occ-1",
          appointmentId: "appt-1",
          startsAt,
          endsAt,
          isTentative: false,
          completionStatus: "COMPLETED",
          meetingEndedAt: null,
          meetingEndedReason: null,
        },
        { now },
      ),
    ).toBe("joinable");

    expect(
      getOccurrenceJoinState(
        {
          id: "occ-1",
          startsAt,
          endsAt,
          isTentative: false,
          completionStatus: "COMPLETED",
          meeting: { id: "mtg-1", endedAt: endsAt, endedReason: "call_ended" },
        },
        { rejoinGraceMs: REJOIN_GRACE_MS, now },
      ),
    ).toBe("ended");
  });

  it("allows rejoin during the slot when endedReason is ended_early", () => {
    const now = new Date();
    const startsAt = new Date(now.getTime() - 10 * MINUTE);
    const endsAt = new Date(now.getTime() + 20 * MINUTE);

    expect(
      getOccurrenceJoinState(
        {
          id: "occ-1",
          startsAt,
          endsAt,
          isTentative: false,
          completionStatus: "SCHEDULED",
          meeting: {
            id: "mtg-1",
            endedAt: new Date(now.getTime() - 2 * MINUTE),
            endedReason: "ended_early",
          },
        },
        { now },
      ),
    ).toBe("joinable");
  });
});

describe("POST /api/meetings/[meetingId]/join, /end, /live, /extend", () => {
  const params = Promise.resolve({ meetingId: "occurrence-slot-1" });
  const req = {} as never;

  it("upserts user before membership and leaves attendance writes to Stream webhooks on join", async () => {
    const res = await joinPOST(req, { params });

    expect(res.status).toBe(200);
    expect(sequence).toEqual(["upsertUsersToStream", "updateCallMembers"]);
    expect(mockAttendanceUpsert).not.toHaveBeenCalled();
    expect(mockPresenceCreate).not.toHaveBeenCalled();
    expect(mockParticipantUpdateMany).not.toHaveBeenCalled();
    expect(mockUpdateUserPermissions).not.toHaveBeenCalled();
  });

  it("grants publish permissions to WEBINAR and CLASS hosts on join", async () => {
    for (const appointmentType of ["WEBINAR", "CLASS"] as const) {
      mockUpdateUserPermissions.mockClear();
      mockMeetingFindUnique.mockResolvedValue(
        makeLiveMeetingRow({ appointmentType }),
      );

      const res = await joinPOST(req, { params });
      expect(res.status).toBe(200);
      expect(mockUpdateUserPermissions).toHaveBeenCalledWith({
        user_id: "user-host",
        grant_permissions: ["send-audio", "send-video", "screenshare"],
      });
    }
  });

  it("revokes publish permissions from WEBINAR and CLASS attendees on join", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-attendee", banned: false },
    });
    mockUserFindUnique.mockResolvedValue({ consultantProfileId: null });

    for (const appointmentType of ["WEBINAR", "CLASS"] as const) {
      mockUpdateUserPermissions.mockClear();
      mockMeetingFindUnique.mockResolvedValue(
        makeLiveMeetingRow({ appointmentType }),
      );

      const res = await joinPOST(req, { params });
      expect(res.status).toBe(200);
      expect(mockUpdateUserPermissions).toHaveBeenCalledWith({
        user_id: "user-attendee",
        revoke_permissions: ["send-audio", "send-video", "screenshare"],
      });
    }
  });

  it("leaves 1:1 consultee permissions untouched, since Stream rejects any name outside publish permissions", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-consultee", banned: false },
    });
    mockUserFindUnique.mockResolvedValue({ consultantProfileId: null });
    mockMeetingFindUnique.mockResolvedValue(
      makeLiveMeetingRow({ appointmentType: "CONSULTATION" }),
    );

    const res = await joinPOST(req, { params });
    expect(res.status).toBe(200);
    expect(mockUpdateUserPermissions).not.toHaveBeenCalled();
  });

  it("ends the Stream call for the host and leaves Meeting.endedAt to the call.ended webhook", async () => {
    const res = await endPOST(req, { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ended: true,
      callId: "occurrence-slot-1",
    });
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockMeetingUpdateMany).not.toHaveBeenCalled();
  });

  it("transitions call to live for host and refuses participant on /live", async () => {
    const hostRes = await livePOST(req, { params });
    expect(hostRes.status).toBe(200);
    expect(mockGoLive).toHaveBeenCalledTimes(1);

    mockUserFindUnique.mockResolvedValue({ consultantProfileId: null });
    const participantRes = await livePOST(req, { params });
    expect(participantRes.status).toBe(403);
  });

  it("extends call duration by +15m once, refuses a second extension with 409 alreadyExtended, and returns 409 on conflict", async () => {
    const okRes = await extendPOST(req, { params });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json();
    expect(okBody).toMatchObject({
      extended: true,
      addedSeconds: 900,
      maxDurationSeconds: 7200,
      extensionsUsed: 1,
      hasConflictingNextBooking: false,
    });
    expect(mockCallUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        settings_override: { limits: { max_duration_seconds: 7200 } },
        custom: expect.objectContaining({
          extendedSeconds: 900,
          extensionsUsed: 1,
        }),
      }),
    );

    mockCallGet.mockResolvedValueOnce({
      call: {
        settings: { limits: { max_duration_seconds: 7200 } },
        custom: { extendedSeconds: 900, extensionsUsed: 1 },
      },
    });
    const secondRes = await extendPOST(req, { params });
    expect(secondRes.status).toBe(409);
    const secondBody = await secondRes.json();
    expect(secondBody.alreadyExtended).toBe(true);

    mockOccurrenceFindFirst.mockResolvedValue({
      id: "next-slot",
      startsAt: new Date(Date.now() + 10 * MINUTE),
    });
    const conflictRes = await extendPOST(req, { params });
    expect(conflictRes.status).toBe(409);
    const conflictBody = await conflictRes.json();
    expect(conflictBody.hasConflictingNextBooking).toBe(true);
  });

  it("fails closed with 503 and does not call call.update when call.get fails on /extend", async () => {
    mockCallGet.mockRejectedValueOnce(new Error("stream read failed"));

    const res = await extendPOST(req, { params });

    expect(res.status).toBe(503);
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });
});

describe("OverrunBanner state & Trial in-call chat guard", () => {
  it("disables in-call chat for TRIAL and enables it for paid session types", () => {
    expect(isInCallChatAllowed("TRIAL")).toBe(false);
    expect(isInCallChatAllowed("CONSULTATION")).toBe(true);
    expect(isInCallChatAllowed("SUBSCRIPTION")).toBe(true);
    expect(isInCallChatAllowed("WEBINAR")).toBe(true);
    expect(isInCallChatAllowed("CLASS")).toBe(true);
  });

  it("transitions OverrunBanner across ending-soon (T-5m), overrun-grace (T+0), and cap-imminent (Cap-2m)", () => {
    const startsAt = new Date("2026-10-03T10:00:00.000Z");
    const endsAt = new Date("2026-10-03T11:00:00.000Z");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        now: new Date("2026-10-03T10:30:00.000Z"),
      }).phase,
    ).toBe("hidden");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        now: new Date("2026-10-03T10:56:00.000Z"),
      }).phase,
    ).toBe("ending-soon");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        now: new Date("2026-10-03T11:05:00.000Z"),
      }).phase,
    ).toBe("overrun-grace");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        now: new Date("2026-10-03T11:29:00.000Z"),
      }).phase,
    ).toBe("cap-imminent");
  });

  it("honors the 45-minute base floor for 30-minute sessions and prefers Stream timer_ends_at when present", () => {
    const startsAt = new Date("2026-10-03T10:00:00.000Z");
    const endsAt = new Date("2026-10-03T10:30:00.000Z");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        now: new Date("2026-10-03T10:59:00.000Z"),
      }).phase,
    ).toBe("overrun-grace");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        now: new Date("2026-10-03T11:14:00.000Z"),
      }).phase,
    ).toBe("cap-imminent");

    expect(
      computeOverrunBannerState({
        startsAt,
        endsAt,
        timerEndsAt: "2026-10-03T11:20:00.000Z",
        now: new Date("2026-10-03T11:14:00.000Z"),
      }).phase,
    ).toBe("overrun-grace");
  });

  it("maps post-reconciliation occurrence outcomes in SessionTimeline slotStatus", () => {
    const baseVm = {
      occurrenceId: "occ-1",
      appointmentId: "appt-1",
      startsAt: new Date(Date.now() - 120 * MINUTE),
      endsAt: new Date(Date.now() - 60 * MINUTE),
      isTentative: false,
      completionStatus: "COMPLETED",
      meetingId: "mtg-1",
      meetingEndedAt: new Date(Date.now() - 60 * MINUTE),
      meetingEndedReason: "call_ended",
    };

    expect(slotStatus({ ...baseVm, outcome: "DELIVERED" }, 15 * MINUTE)).toBe(
      "completed",
    );
    expect(slotStatus({ ...baseVm, outcome: "CUT_SHORT" }, 15 * MINUTE)).toBe(
      "cutShort",
    );
    expect(
      slotStatus({ ...baseVm, outcome: "CONSULTANT_NO_SHOW" }, 15 * MINUTE),
    ).toBe("noShow");
    expect(
      slotStatus({ ...baseVm, outcome: "INCONCLUSIVE" }, 15 * MINUTE),
    ).toBe("inconclusive");
    expect(slotStatus({ ...baseVm, outcome: null }, 15 * MINUTE)).toBe(
      "completed",
    );
  });
});
