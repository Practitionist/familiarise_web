/**
 * @jest-environment node
 */

/**
 * Issue #1999 — End-to-End Stream Video/Chat Contract, Stage Route,
 * Consultee-First Join, and Adjacent Defect Regression Suite.
 */

const mockGuardMeetingRoute = jest.fn();
const mockUpdateUserPermissions = jest.fn();
const mockAppointmentParticipantFindFirst = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentParticipant: {
      findFirst: (...a: unknown[]) => mockAppointmentParticipantFindFirst(...a),
    },
  },
}));

jest.mock("../../lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...a: unknown[]) => mockGuardMeetingRoute(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  StreamUnavailableError: class extends Error {},
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: () => ({
    video: {
      call: () => ({
        updateUserPermissions: (payload: unknown) => {
          const contracts =
            require("../../lib/stream/video-contracts") as typeof import("../../lib/stream/video-contracts");
          contracts.assertValidUpdateUserPermissions(payload);
          return mockUpdateUserPermissions(payload);
        },
      }),
    },
  }),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST as stagePOST } from "../../app/api/meetings/[meetingId]/stage/route";
import {
  STREAM_CALL_MEMBER_ROLES,
  STREAM_OWN_CAPABILITIES,
  STREAM_PUBLISH_PERMISSIONS,
  assertValidGetOrCreateCall,
  assertValidUpdateCallMembers,
  assertValidUpdateUserPermissions,
  filterStreamPublishPermissions,
} from "../../lib/stream/video-contracts";
import { applyErrorBudget } from "../../sentry.shared.config";
import type * as Sentry from "@sentry/nextjs";

describe("Issue #1999 — Stream Video SDK Enum Contract Validation", () => {
  describe("assertValidUpdateUserPermissions", () => {
    it("accepts canonical lower-kebab OwnCapability permissions", () => {
      expect(() =>
        assertValidUpdateUserPermissions({
          user_id: "user_1",
          grant_permissions: [...STREAM_PUBLISH_PERMISSIONS],
        }),
      ).not.toThrow();

      expect(() =>
        assertValidUpdateUserPermissions({
          user_id: "user_1",
          revoke_permissions: ["send-audio", "send-video", "screenshare"],
        }),
      ).not.toThrow();
    });

    it("rejects mixed-case or nonexistent permission strings (e.g. 'send-Audio', 'publish-video', 'admin')", () => {
      for (const bad of ["send-Audio", "publish-video"]) {
        expect(() =>
          assertValidUpdateUserPermissions({
            user_id: "user_1",
            grant_permissions: [bad],
          }),
        ).toThrow(`Invalid grant_permissions capability "${bad}"`);
      }

      expect(() =>
        assertValidUpdateUserPermissions({
          user_id: "user_1",
          revoke_permissions: ["admin"],
        }),
      ).toThrow(/Invalid revoke_permissions capability "admin"/);
    });

    it("rejects empty or missing user_id", () => {
      expect(() =>
        assertValidUpdateUserPermissions({
          user_id: "",
          grant_permissions: ["send-audio"],
        }),
      ).toThrow(/non-empty user_id/);
    });
  });

  describe("assertValidUpdateCallMembers", () => {
    it("accepts registered call member roles ('call_member', 'co_presenter', 'admin', 'user')", () => {
      for (const role of STREAM_CALL_MEMBER_ROLES) {
        expect(() =>
          assertValidUpdateCallMembers({
            update_members: [{ user_id: "user_1", role }],
          }),
        ).not.toThrow();
      }
    });

    it("rejects unregistered call roles ('host', 'moderator', 'speaker')", () => {
      for (const invalidRole of ["host", "moderator", "speaker"]) {
        expect(() =>
          assertValidUpdateCallMembers({
            update_members: [{ user_id: "user_1", role: invalidRole }],
          }),
        ).toThrow(`Invalid Stream call member role "${invalidRole}"`);
      }
    });
  });

  describe("assertValidGetOrCreateCall", () => {
    it("accepts valid server-side call creation payload with starts_at, custom, and settings_override", () => {
      expect(() =>
        assertValidGetOrCreateCall({
          data: {
            created_by_id: "host_1",
            starts_at: new Date(),
            members: [
              { user_id: "host_1", role: "admin" },
              { user_id: "attendee_1", role: "call_member" },
            ],
            custom: {
              appointmentId: "appt_1",
              appointmentType: "CONSULTATION",
              title: "1:1 Consultation",
              hostUserId: "host_1",
              hostUserIds: ["host_1"],
            },
            settings_override: {
              backstage: { enabled: false },
              limits: {
                max_duration_seconds: 5400,
                max_participants: 2,
                max_participants_exclude_owner: false,
                max_participants_exclude_roles: [],
              },
            },
          },
        }),
      ).not.toThrow();
    });

    it("rejects missing created_by_id, negative join_ahead_time_seconds, or invalid excluded roles", () => {
      expect(() => assertValidGetOrCreateCall({ data: {} })).toThrow(
        /non-empty data\.created_by_id/,
      );

      expect(() =>
        assertValidGetOrCreateCall({
          data: {
            created_by_id: "host_1",
            settings_override: {
              backstage: { enabled: true, join_ahead_time_seconds: -1 },
            },
          },
        }),
      ).toThrow(/non-negative join_ahead_time_seconds/);

      expect(() =>
        assertValidGetOrCreateCall({
          data: {
            created_by_id: "host_1",
            settings_override: {
              limits: { max_participants_exclude_roles: ["host"] },
            },
          },
        }),
      ).toThrow(/Invalid max_participants_exclude_roles role "host"/);
    });
  });

  describe("filterStreamPublishPermissions", () => {
    it("filters requested permissions down to valid media publish capabilities", () => {
      expect(
        filterStreamPublishPermissions([
          "send-audio",
          "send-Audio",
          "send-video",
          "end-call",
          "screenshare",
        ]),
      ).toEqual(["send-audio", "send-video", "screenshare"]);
      expect(STREAM_OWN_CAPABILITIES.length).toBeGreaterThanOrEqual(30);
    });
  });
});

async function callStageEndpoint(
  callerRole: "host" | "participant",
  payload: Record<string, unknown>,
) {
  mockGuardMeetingRoute.mockResolvedValue({
    ok: true,
    userId: callerRole === "host" ? "cohost_1" : "attendee_1",
    meetingId: "m1",
    access: {
      hasAccess: true,
      role: callerRole,
      streamCallId: "occurrence-webinar-1",
      appointment: { id: "appt_w1", appointmentType: "WEBINAR" },
    },
  });
  const req = new NextRequest("http://localhost/api/meetings/m1/stage", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return stagePOST(req, { params: Promise.resolve({ meetingId: "m1" }) });
}

describe("Issue #1999 — POST /api/meetings/[meetingId]/stage (Host & Co-Presenter Stage Controls)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateUserPermissions.mockResolvedValue({});
    mockAppointmentParticipantFindFirst.mockResolvedValue({ id: "part_1" });
  });

  it("allows a host or co-presenter to grant stage publish permissions to an attendee", async () => {
    const res = await callStageEndpoint("host", {
      targetUserId: "attendee_42",
      action: "grant",
      permissions: ["send-audio", "send-video"],
    });

    expect(res.status).toBe(200);
    expect(mockAppointmentParticipantFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          appointmentId: "appt_w1",
          userId: "attendee_42",
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
        },
      }),
    );
    expect(mockUpdateUserPermissions).toHaveBeenCalledWith({
      user_id: "attendee_42",
      grant_permissions: ["send-audio", "send-video"],
    });
  });

  it("rejects granting stage permissions to a targetUserId who is not an active participant of the appointment", async () => {
    mockAppointmentParticipantFindFirst.mockResolvedValue(null);
    const res = await callStageEndpoint("host", {
      targetUserId: "stranger_99",
      action: "grant",
      permissions: ["send-audio"],
    });

    expect(res.status).toBe(403);
    expect(mockUpdateUserPermissions).not.toHaveBeenCalled();
  });

  it("allows a host or co-presenter to revoke stage publish permissions when declining/removing from stage", async () => {
    const res = await callStageEndpoint("host", {
      targetUserId: "attendee_42",
      action: "revoke",
    });

    expect(res.status).toBe(200);
    expect(mockUpdateUserPermissions).toHaveBeenCalledWith({
      user_id: "attendee_42",
      revoke_permissions: ["send-audio", "send-video", "screenshare"],
    });
  });

  it("rejects non-host participants attempting to grant stage permissions", async () => {
    const res = await callStageEndpoint("participant", {
      targetUserId: "attendee_1",
      action: "grant",
    });

    expect(res.status).toBe(403);
    expect(mockUpdateUserPermissions).not.toHaveBeenCalled();
  });
});

describe("Issue #1999 — Adjacent Defect 6: Sentry Error Budget & Expected Outcomes", () => {
  it("drops expected=true events at info level while preserving warning re-levels (throttled per key)", () => {
    const infoEv = {
      message: "expected info refusal",
      level: "info",
      tags: { expected: "true" },
    } as unknown as Sentry.Event;
    expect(applyErrorBudget(infoEv)).toBeNull();

    const warnEv = {
      message: "expected warning refusal",
      level: "warning",
      tags: { expected: "true" },
    } as unknown as Sentry.Event;
    expect(applyErrorBudget(warnEv)).toBe(warnEv);
    // Second identical warning within the 10m window is throttled by the error budget
    expect(applyErrorBudget(warnEv)).toBeNull();
  });
});
