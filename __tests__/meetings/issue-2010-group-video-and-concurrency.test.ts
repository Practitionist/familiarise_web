/**
 * @jest-environment node
 */

/**
 * Issue #2010 — Regression suite for:
 * 1. WEBINAR and CLASS Stream Video call provisioning (complete VideoSettingsRequest
 *    and AudioSettingsRequest required by Stream's Go backend, contract guard against
 *    partial settings_override.video/audio that caused HTTP 400 code 4).
 * 2. Single-active-session consultant concurrency across all 5 offering types
 *    (Consultation, Subscription, Webinar, Class, Trial) and roles (Host,
 *    Accepted Co-Presenter/Collaborator, Consultee).
 */

import { buildCallSettingsOverride } from "@/lib/meetings/room-ready";
import { DEFAULT_VIDEO_CONFIG } from "@/lib/stream/video-quality";
import { assertValidGetOrCreateCall } from "@/lib/stream/video-contracts";
import {
  assertCollaboratorsAvailable,
  assertConsultantAvailableForWindows,
  ConsultantScheduleConflictError,
} from "@/lib/collaborators/availability";
import {
  scheduleClassMakeUp,
  type HostedClass,
} from "@/lib/booking/class-sessions";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { liveParticipant } from "@/lib/booking/participants";
import { OCCUPYING_OCCURRENCE_WHERE } from "@/utils/scheduling-engine/occupancyPolicy";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import prisma from "@/lib/prisma";

describe("Issue #2010 Part 1 — Webinar & Class Stream Video Settings Contract", () => {
  it("produces complete VideoSettingsRequest and AudioSettingsRequest for WEBINAR and CLASS that pass assertValidGetOrCreateCall", () => {
    for (const appointmentType of ["WEBINAR", "CLASS"] as const) {
      const settingsOverride = buildCallSettingsOverride(
        appointmentType,
        3600,
        undefined,
        DEFAULT_VIDEO_CONFIG,
      );
      expect(settingsOverride).toBeDefined();
      expect(() =>
        assertValidGetOrCreateCall({
          data: {
            created_by_id: "host-user-1",
            starts_at: new Date("2026-10-06T12:00:00.000Z"),
            members: [
              { user_id: "host-user-1", role: "admin" },
              { user_id: "attendee-user-1", role: "call_member" },
            ],
            custom: {
              appointmentId: "appt-1",
              appointmentType,
              title: "Group Session",
              hostUserId: "host-user-1",
              hostUserIds: ["host-user-1"],
            },
            settings_override: settingsOverride,
          },
        }),
      ).not.toThrow();

      expect(settingsOverride?.video).toEqual({
        enabled: true,
        camera_default_on: false,
        camera_facing: "front",
        access_request_enabled: true,
        target_resolution: {
          width: 1280,
          height: 720,
          bitrate: 1500000,
        },
      });
      expect(settingsOverride?.audio).toEqual({
        mic_default_on: false,
        speaker_default_on: true,
        default_device: "speaker",
        access_request_enabled: true,
        opus_dtx_enabled: true,
        redundant_coding_enabled: true,
      });
    }
  });

  it("rejects partial settings_override.video missing enabled or target_resolution (Sentry FAMILIARISE_WEB-4E reproduction)", () => {
    expect(() =>
      assertValidGetOrCreateCall({
        data: {
          created_by_id: "host-user-1",
          settings_override: {
            video: {
              camera_default_on: false,
              access_request_enabled: true,
            },
          },
        },
      }),
    ).toThrow(
      /settings_override\.video requires boolean enabled, camera_default_on, and access_request_enabled/,
    );

    expect(() =>
      assertValidGetOrCreateCall({
        data: {
          created_by_id: "host-user-1",
          settings_override: {
            video: {
              enabled: true,
              camera_default_on: false,
              camera_facing: "front",
              access_request_enabled: true,
            },
          },
        },
      }),
    ).toThrow(
      /settings_override\.video\.target_resolution requires width >= 240, height >= 240, and bitrate > 0/,
    );
  });

  it("rejects invalid target_resolution dimensions (< 240) or non-positive bitrate", () => {
    expect(() =>
      assertValidGetOrCreateCall({
        data: {
          created_by_id: "host-user-1",
          settings_override: {
            video: {
              enabled: true,
              camera_default_on: false,
              camera_facing: "front",
              access_request_enabled: true,
              target_resolution: { width: 0, height: 0, bitrate: 0 },
            },
          },
        },
      }),
    ).toThrow(
      /settings_override\.video\.target_resolution requires width >= 240, height >= 240, and bitrate > 0/,
    );
  });

  it("rejects partial settings_override.audio missing required Stream booleans or default_device", () => {
    expect(() =>
      assertValidGetOrCreateCall({
        data: {
          created_by_id: "host-user-1",
          settings_override: {
            audio: {
              mic_default_on: false,
              default_device: "speaker",
              access_request_enabled: true,
            },
          },
        },
      }),
    ).toThrow(
      /settings_override\.audio requires boolean mic_default_on, speaker_default_on, and access_request_enabled/,
    );
  });
});

describe("Issue #2010 Part 2 — Single-Active-Session Consultant Concurrency", () => {
  it("includes TrialSession and direct occurrence.consultantProfileId in collaborator commitmentClauses", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = {
      collaborator: {
        findMany: jest.fn().mockResolvedValue([
          {
            consultantProfileId: "cp-collab-1",
            consultantProfile: {
              user: { id: "u-collab-1", name: "Co-Host Alice" },
            },
          },
        ]),
      },
      appointmentOccurrence: { findFirst },
    };

    await assertCollaboratorsAvailable(db as never, {
      planType: "WEBINAR",
      planId: "plan-1",
      startsAt: new Date("2026-10-06T12:00:00.000Z"),
      endsAt: new Date("2026-10-06T13:00:00.000Z"),
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    const commitmentOr = findFirst.mock.calls[0][0].where.appointment.AND[0].OR;
    expect(commitmentOr).toEqual(
      expect.arrayContaining([
        { trial: { is: { consultantProfileId: "cp-collab-1" } } },
        {
          occurrences: {
            some: {
              consultantProfileId: "cp-collab-1",
              ...OCCUPYING_OCCURRENCE_WHERE,
            },
          },
        },
        // A co-host booked as someone else's client is busy too, unless the
        // seat is a lapsed hold.
        {
          participants: {
            some: expect.objectContaining({
              ...liveParticipant("u-collab-1"),
              NOT: expect.objectContaining({ status: "HELD" }),
            }),
          },
        },
      ]),
    );
  });

  it("assertConsultantAvailableForWindows throws ConsultantScheduleConflictError when an overlapping session exists", async () => {
    const db = {
      appointmentOccurrence: {
        findFirst: jest.fn().mockResolvedValue({ id: "occ-conflict-1" }),
      },
    };

    await expect(
      assertConsultantAvailableForWindows(db as never, {
        consultantProfileId: "cp-host-1",
        consultantUserId: "user-host-1",
        windows: [
          {
            startsAt: new Date("2026-10-06T12:00:00.000Z"),
            endsAt: new Date("2026-10-06T13:00:00.000Z"),
          },
        ],
        excludeAppointmentIds: ["appt-self"],
      }),
    ).rejects.toBeInstanceOf(ConsultantScheduleConflictError);
  });

  it("scheduleClassMakeUp falls back to classPlan.consultantProfileId and maps 23P01 overlap to 409 BookingRuleError", async () => {
    const now = new Date();
    const missedStart = new Date(now.getTime() - 3_600_000);
    const missedEnd = new Date(missedStart.getTime() + 3_600_000);
    // Host-set times sit on the half-hour grid.
    const makeUpStart = new Date(
      Math.ceil((now.getTime() + 86_400_000) / 1_800_000) * 1_800_000,
    );

    const createSpy = jest
      .fn()
      .mockRejectedValue(
        new Error(
          'ERROR: conflicting key value violates exclusion constraint "occurrence_no_confirmed_overlap" (23P01)',
        ),
      );

    const mockTx = {
      appointmentOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          ordinal: 1,
          startsAt: missedStart,
          endsAt: missedEnd,
          completionStatus: "CANCELLED",
          hostCancelledAt: now,
          voidedAt: null,
          seatsSettledAt: null,
          consultantProfileId: null, // legacy NULL row
        }),
        create: createSpy,
      },
      collaborator: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      // The host-time try-locks: no atom is held.
      $queryRaw: jest.fn().mockResolvedValue([]),
      // The plan row, written before the team is read.
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const txSpy = jest
      .spyOn(prisma, "$transaction")
      .mockImplementation(async (fn: unknown) =>
        (fn as (tx: unknown) => Promise<unknown>)(mockTx),
      );
    // The slot batch's pre-reads (the source's span, the accepted co-hosts)
    // and the host check run beside the transaction.
    const spanSpy = jest
      .spyOn(prisma.appointmentOccurrence, "findFirst")
      .mockResolvedValue({
        startsAt: missedStart,
        endsAt: missedEnd,
      } as never);
    const cohostSpy = jest
      .spyOn(prisma.collaborator, "findMany")
      .mockResolvedValue([]);
    const hostCheckSpy = jest
      .spyOn(ScheduleValidationService.prototype, "revalidateConflicts")
      .mockResolvedValue({ isValid: true, errors: [], warnings: [] });

    const hosted: HostedClass = {
      found: true,
      appointment: { id: "appt-class-1", organizationId: null } as never,
      cls: {
        id: "class-1",
        classPlan: {
          title: "System Design Cohort",
          id: "plan-class-1",
          consultantProfileId: "cp-host-fallback",
          consultantProfile: { user: { id: "u-host", name: "Host" } },
        },
      } as never,
    };

    try {
      await expect(
        scheduleClassMakeUp(hosted, "occ-missed-1", makeUpStart),
      ).rejects.toEqual(
        expect.objectContaining({
          name: "BookingRuleError",
          code: "SCHEDULE_CONFLICT",
          httpStatus: 409,
        } satisfies Partial<BookingRuleError>),
      );

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consultantProfileId: "cp-host-fallback",
            isTentative: false,
          }),
        }),
      );
    } finally {
      txSpy.mockRestore();
      spanSpy.mockRestore();
      cohostSpy.mockRestore();
      hostCheckSpy.mockRestore();
    }
  });
});
