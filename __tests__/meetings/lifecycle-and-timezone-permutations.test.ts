/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockMeetingFindUnique = jest.fn();
const mockMeetingUpdateMany = jest.fn();
const mockAttendanceUpsert = jest.fn();
const mockAttendanceUpdateMany = jest.fn();
const mockPresenceFindFirst = jest.fn();
const mockPresenceCreate = jest.fn();
const mockPresenceUpdateMany = jest.fn();
const mockParticipantFindFirst = jest.fn();
const mockParticipantUpdateMany = jest.fn();
const mockOccurrenceFindFirst = jest.fn();
const mockOccurrenceUpdateMany = jest.fn();
const mockUserFindUnique = jest.fn();
const mockEnd = jest.fn();

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("../../lib/auth-client", () => ({
  useSession: jest.fn(() => ({ data: null, isPending: false })),
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
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
        end: (...a: unknown[]) => mockEnd(...a),
      }),
    },
  })),
}));

jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    consentArtifact: { findFirst: jest.fn() },
    meeting: {
      findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a),
      updateMany: (...a: unknown[]) => mockMeetingUpdateMany(...a),
    },
    meetingAttendance: {
      upsert: (...a: unknown[]) => mockAttendanceUpsert(...a),
      updateMany: (...a: unknown[]) => mockAttendanceUpdateMany(...a),
    },
    meetingPresence: {
      findFirst: (...a: unknown[]) => mockPresenceFindFirst(...a),
      create: (...a: unknown[]) => mockPresenceCreate(...a),
      updateMany: (...a: unknown[]) => mockPresenceUpdateMany(...a),
    },
    appointmentParticipant: {
      findFirst: (...a: unknown[]) => mockParticipantFindFirst(...a),
      updateMany: (...a: unknown[]) => mockParticipantUpdateMany(...a),
    },
    appointmentOccurrence: {
      findFirst: (...a: unknown[]) => mockOccurrenceFindFirst(...a),
      updateMany: (...a: unknown[]) => mockOccurrenceUpdateMany(...a),
    },
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
    },
    collaborator: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  client.$transaction = (fn: (tx: typeof client) => unknown) => fn(client);
  return {
    __esModule: true,
    default: client,
  };
});

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

import { NextRequest } from "next/server";
import { toOccurrenceLike } from "../../lib/appointments/view-model";
import { deriveBookingPresentation } from "../../lib/dashboard/money-state";
import { imminentSessionItem } from "../../lib/dashboard/action-items";
import { formatScheduledAt } from "../../app/meetings/[id]/session-info";
import { formatInViewerZone } from "../../lib/time/viewer-zone";
import { POST as endPost } from "../../app/api/meetings/[meetingId]/end/route";
import { POST as reopenPost } from "../../app/api/meetings/[meetingId]/reopen/route";

const MINUTE = 60_000;

function makeMeetingRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "mtg-perm-1",
    streamCallId: "occurrence-occ-perm-1",
    endedAt: null as Date | null,
    endedReason: null as string | null,
    occurrence: {
      id: "occ-perm-1",
      appointmentId: "appt-perm-1",
      consultantProfileId: "cprof-host-1",
      startsAt: new Date(now - 20 * MINUTE),
      endsAt: new Date(now + 40 * MINUTE),
      isTentative: false,
      completionStatus: "IN_PROGRESS",
      appointment: {
        id: "appt-perm-1",
        appointmentType: "CLASS",
        consultation: null,
        subscription: null,
        webinar: null,
        class: {
          id: "cls-1",
          status: "IN_PROGRESS",
          classPlan: {
            id: "cplan-1",
            title: "Distributed Systems Masterclass",
            consultantProfileId: "cprof-host-1",
          },
        },
        trial: null,
      },
    },
    ...overrides,
  };
}

describe("Meeting lifecycle & timezone P&C unification (#2080)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "host-user-1" } });
    mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
    mockAttendanceUpsert.mockResolvedValue({});
    mockAttendanceUpdateMany.mockResolvedValue({ count: 1 });
    mockPresenceFindFirst.mockResolvedValue(null);
    mockPresenceCreate.mockResolvedValue({});
    mockPresenceUpdateMany.mockResolvedValue({ count: 1 });
    mockParticipantFindFirst.mockResolvedValue(null);
    mockParticipantUpdateMany.mockResolvedValue({ count: 0 });
    mockOccurrenceFindFirst.mockResolvedValue(null);
    mockOccurrenceUpdateMany.mockResolvedValue({ count: 1 });
    mockUserFindUnique.mockResolvedValue({
      role: "CONSULTANT",
      consultantProfileId: "cprof-host-1",
    });
    mockEnd.mockResolvedValue({});
  });

  describe("Cross-surface status parity (Home, Appointments, Detail, Room)", () => {
    it("preserves meeting termination on toOccurrenceLike so Consultee Detail hides stale Join", () => {
      const now = new Date("2026-10-10T15:00:00.000Z");
      const rawRow = {
        id: "occ-1",
        startsAt: new Date(now.getTime() - 15 * MINUTE),
        endsAt: new Date(now.getTime() + 45 * MINUTE),
        isTentative: false,
        completionStatus: "IN_PROGRESS",
        meeting: {
          id: "mtg-1",
          endedAt: new Date(now.getTime() - 2 * MINUTE),
          endedReason: "call_ended",
        },
      };

      const like = toOccurrenceLike(rawRow);
      expect(like.meeting).toEqual({
        id: "mtg-1",
        endedAt: rawRow.meeting.endedAt,
        endedReason: "call_ended",
      });
    });

    it("transitions deriveBooking immediately from CONFIRMED to COMPLETED when host ends session mid-slot, while keeping CONFIRMED on self-leave", () => {
      const now = new Date("2026-10-10T15:00:00.000Z");
      const baseOcc = {
        startsAt: new Date(now.getTime() - 10 * MINUTE),
        endsAt: new Date(now.getTime() + 50 * MINUTE),
        isTentative: false,
        completionStatus: "IN_PROGRESS",
      };
      const basePayment = {
        id: "pay-1",
        amount: 500000,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentMethod: "CARD",
        paymentGateway: "RAZORPAY",
        receiptUrl: null,
        consumerInvoice: null,
        createdAt: new Date("2026-10-08T10:00:00.000Z"),
      };

      // Self-leave (`meeting.endedAt === null`) -> booking remains active CONFIRMED (`JOIN`)
      const activePresentation = deriveBookingPresentation(
        {
          appointmentType: "CONSULTATION",
          request: { kind: "CONSULTATION", status: "APPROVED" },
          names: { consultant: "Dr. Rao", payer: "Ananya" },
          occurrences: [
            {
              ...baseOcc,
              meeting: { endedAt: null, endedReason: null },
            },
          ],
          payments: [basePayment],
          childPayments: [],
          refunds: [],
          disputes: [],
          sponsorOrgName: null,
          holdExpiresAt: null,
        },
        "CONSULTEE",
        { now },
      );
      expect(activePresentation.bookingState.state).toBe("CONFIRMED");
      expect(activePresentation.nextAction.kind).toBe("JOIN");

      // Deliberate host end (`endedReason: "call_ended"`) -> immediately COMPLETED (`RATE`)
      const endedPresentation = deriveBookingPresentation(
        {
          appointmentType: "CONSULTATION",
          request: { kind: "CONSULTATION", status: "APPROVED" },
          names: { consultant: "Dr. Rao", payer: "Ananya" },
          occurrences: [
            {
              ...baseOcc,
              meeting: {
                endedAt: new Date(now.getTime() - MINUTE),
                endedReason: "call_ended",
              },
            },
          ],
          payments: [basePayment],
          childPayments: [],
          refunds: [],
          disputes: [],
          sponsorOrgName: null,
          holdExpiresAt: null,
        },
        "CONSULTEE",
        { now },
      );
      expect(endedPresentation.bookingState.state).toBe("COMPLETED");
      expect(endedPresentation.nextAction.kind).toBe("RATE");
    });

    it("keeps imminentSessionItem joinable during +30m post-call overrun grace unless host ended session", () => {
      const now = new Date("2026-10-10T15:10:00.000Z");
      const startsAt = new Date("2026-10-10T14:00:00.000Z");
      const endsAt = new Date("2026-10-10T15:00:00.000Z");

      // 10m into post-call grace, call still running -> actionable Join item shown
      expect(
        imminentSessionItem(
          [
            {
              id: "occ-overrun",
              appointmentId: "appt-overrun",
              startsAt,
              endsAt,
              title: "System Design Deep Dive",
              meeting: { id: "mtg-overrun", endedAt: null, endedReason: null },
            },
          ],
          "dashboard/consultant/c-1/appointments",
          now,
        ),
      ).not.toBeNull();

      // Host ended call explicitly -> no stale Join banner on Home tab
      expect(
        imminentSessionItem(
          [
            {
              id: "occ-ended",
              appointmentId: "appt-overrun",
              startsAt,
              endsAt,
              title: "System Design Deep Dive",
              meeting: {
                id: "mtg-ended",
                endedAt: new Date("2026-10-10T15:02:00.000Z"),
                endedReason: "call_ended",
              },
            },
          ],
          "dashboard/consultant/c-1/appointments",
          now,
        ),
      ).toBeNull();
    });
  });

  describe("Cross-timezone formatting across Asia/Kolkata, America/Los_Angeles, and UTC", () => {
    it("formats session schedules across midnight boundaries accurately in each viewer timezone", () => {
      // 2026-10-10T20:00:00Z is:
      // - Oct 10, 8:00 PM in UTC
      // - Oct 11, 1:30 AM in Asia/Kolkata (+05:30)
      // - Oct 10, 1:00 PM in America/Los_Angeles (-07:00)
      const startsAt = new Date("2026-10-10T20:00:00.000Z");

      const istFormatted = formatScheduledAt(startsAt, "Asia/Kolkata");
      expect(istFormatted).toContain("1:30 AM");

      const laFormatted = formatScheduledAt(startsAt, "America/Los_Angeles");
      expect(laFormatted).toContain("1:00 PM");

      expect(formatInViewerZone(startsAt, "Asia/Kolkata", "yyyy-MM-dd")).toBe(
        "2026-10-11",
      );
      expect(
        formatInViewerZone(startsAt, "America/Los_Angeles", "yyyy-MM-dd"),
      ).toBe("2026-10-10");
      expect(formatInViewerZone(startsAt, "UTC", "yyyy-MM-dd")).toBe(
        "2026-10-10",
      );
    });
  });

  describe("POST /api/meetings/[meetingId]/end & POST /api/meetings/[meetingId]/reopen", () => {
    it("stamps Meeting.endedAt synchronously via CAS when host ends the session for everyone", async () => {
      mockMeetingFindUnique.mockResolvedValue(makeMeetingRow());

      const res = await endPost(
        new NextRequest("http://localhost/api/meetings/mtg-perm-1/end", {
          method: "POST",
        }),
        { params: Promise.resolve({ meetingId: "mtg-perm-1" }) },
      );

      expect(res.status).toBe(200);
      expect(mockEnd).toHaveBeenCalledTimes(1);
      expect(mockMeetingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "mtg-perm-1", endedAt: null },
          data: expect.objectContaining({
            endedReason: "call_ended",
          }),
        }),
      );
    });

    it("rotates streamCallId and clears endedAt via CAS when host reopens a prematurely ended room", async () => {
      mockMeetingFindUnique.mockResolvedValue(
        makeMeetingRow({
          endedAt: new Date(Date.now() - MINUTE),
          endedReason: "call_ended",
        }),
      );

      const res = await reopenPost(
        new NextRequest("http://localhost/api/meetings/mtg-perm-1/reopen", {
          method: "POST",
        }),
        { params: Promise.resolve({ meetingId: "mtg-perm-1" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reopened).toBe(true);
      expect(body.streamCallId).toMatch(/^occurrence-occ-perm-1-r[a-z0-9]+$/);
      expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
        where: { id: "mtg-perm-1", endedAt: { not: null } },
        data: {
          streamCallId: body.streamCallId,
          endedAt: null,
          endedReason: null,
          isRecording: false,
        },
      });
    });

    it("refuses consultees on POST /reopen with 403", async () => {
      mockGetSession.mockResolvedValue({ user: { id: "student-user-9" } });
      mockUserFindUnique.mockResolvedValue({
        role: "CONSULTEE",
        consultantProfileId: null,
      });
      mockParticipantFindFirst.mockResolvedValue({ id: "part-9" });
      mockMeetingFindUnique.mockResolvedValue(
        makeMeetingRow({
          endedAt: new Date(Date.now() - MINUTE),
          endedReason: "call_ended",
        }),
      );

      const res = await reopenPost(
        new NextRequest("http://localhost/api/meetings/mtg-perm-1/reopen", {
          method: "POST",
        }),
        { params: Promise.resolve({ meetingId: "mtg-perm-1" }) },
      );

      expect(res.status).toBe(403);
    });

    it("refuses POST /reopen outside the [startsAt, endsAt + 30m] session window with 409", async () => {
      mockMeetingFindUnique.mockResolvedValue(
        makeMeetingRow({
          endedAt: new Date(Date.now() - 40 * MINUTE),
          endedReason: "call_ended",
          occurrence: {
            id: "occ-perm-1",
            appointmentId: "appt-perm-1",
            consultantProfileId: "cprof-host-1",
            startsAt: new Date(Date.now() - 120 * MINUTE),
            endsAt: new Date(Date.now() - 45 * MINUTE),
            isTentative: false,
            completionStatus: "COMPLETED",
            appointment: makeMeetingRow().occurrence.appointment,
          },
        }),
      );

      const res = await reopenPost(
        new NextRequest("http://localhost/api/meetings/mtg-perm-1/reopen", {
          method: "POST",
        }),
        { params: Promise.resolve({ meetingId: "mtg-perm-1" }) },
      );

      expect(res.status).toBe(409);
    });
  });
});
