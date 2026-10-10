/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockModerationReport = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  count: jest.fn(),
};
const mockConsultantReview = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  updateMany: jest.fn(),
};
const mockUser = {
  findUnique: jest.fn().mockResolvedValue({ id: "user-1" }),
};
const mockMember = {
  findFirst: jest.fn(),
};
const mockAppointment = {
  findUnique: jest.fn(),
};
const mockAppointmentOccurrence = {
  findMany: jest.fn(),
};
const mockAppointmentFeedback = {
  findMany: jest.fn(),
  findUnique: jest.fn(),
  updateMany: jest.fn(),
};
const mockAppointmentSupportThread = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};
const mockRefund = {
  findMany: jest.fn(),
};
const mockDispute = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
};
const mockPlatformFeedback = {
  findUnique: jest.fn(),
  findUniqueOrThrow: jest.fn(),
  updateMany: jest.fn(),
};
const mockNotificationOutbox = {
  upsert: jest.fn(),
};
const mockTransaction = jest.fn();

const mockGetSession = jest.fn();
const mockRequirePrivilegedAuth = jest.fn();
const mockAuthorizeAppointment = jest.fn();
const mockAttemptTrigger = jest.fn().mockResolvedValue({ success: true });
const mockStageTrigger = jest.fn().mockResolvedValue({
  id: "outbox-1",
  workflowId: "test-workflow",
  kind: "SINGLE",
  recipients: ["user-1"],
  payload: {},
  dedupeKey: "dedupe-1",
});
const mockNotifyModerationWarning = jest
  .fn()
  .mockResolvedValue({ success: true });

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    get moderationReport() {
      return mockModerationReport;
    },
    get consultantReview() {
      return mockConsultantReview;
    },
    get user() {
      return mockUser;
    },
    get member() {
      return mockMember;
    },
    get appointment() {
      return mockAppointment;
    },
    get appointmentOccurrence() {
      return mockAppointmentOccurrence;
    },
    get appointmentFeedback() {
      return mockAppointmentFeedback;
    },
    get appointmentSupportThread() {
      return mockAppointmentSupportThread;
    },
    get refund() {
      return mockRefund;
    },
    get dispute() {
      return mockDispute;
    },
    get platformFeedback() {
      return mockPlatformFeedback;
    },
    get notificationOutbox() {
      return mockNotificationOutbox;
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/auth-helpers", () => ({
  requirePrivilegedAuth: (...args: unknown[]) =>
    mockRequirePrivilegedAuth(...args),
  isPrivileged: jest.fn().mockReturnValue(false),
}));

jest.mock("../../lib/api/appointment-access", () => ({
  authorizeAppointment: (...args: unknown[]) =>
    mockAuthorizeAppointment(...args),
  appointmentAuthzError: jest.fn(),
}));

jest.mock("../../lib/data/appointment-detail", () => ({
  appointmentRaterRole: jest.fn().mockReturnValue("CONSULTEE"),
  heldOccurrence: jest.fn().mockReturnValue({}),
}));

jest.mock("../../lib/rate-limit", () => ({
  spamLimiter: {},
  applyRateLimit: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../lib/novu/outbox", () => ({
  attemptTrigger: (...args: unknown[]) => mockAttemptTrigger(...args),
  stageTrigger: (...args: unknown[]) => mockStageTrigger(...args),
}));

jest.mock("../../lib/novu", () => ({
  notifyModerationWarning: (...args: unknown[]) =>
    mockNotifyModerationWarning(...args),
  notifyAccountSuspended: jest.fn().mockResolvedValue({ success: true }),
  notifyAccountBanned: jest.fn().mockResolvedValue({ success: true }),
  notifyVerificationStatusChanged: jest
    .fn()
    .mockResolvedValue({ success: true }),
}));

jest.mock("../../lib/reviews", () => ({
  recomputeConsultantRating: jest.fn().mockResolvedValue(undefined),
  heldOccurrence: jest.fn().mockReturnValue({}),
}));

import prisma from "@/lib/prisma";
import { formatReportReference } from "@/lib/moderation/report-reference";
import {
  readReviewReportContext,
  readReviewReportSignals,
} from "@/lib/moderation/review-context";
import { POST as postReport } from "@/app/api/report/route";
import { GET as getUserReports } from "@/app/api/user/reports/route";
import { PATCH as patchModerationReport } from "@/app/api/staff/moderation/reports/[reportId]/route";
import { PATCH as patchStaffFeedback } from "@/app/api/staff/feedbacks/[feedbackId]/route";
import { GET as getSessionFeedback } from "@/app/api/appointments/[appointmentId]/feedback/route";
import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "@/lib/moderation/side-effects";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

describe("Moderation transparency, review context & feedback CAS invariants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
  });

  describe("formatReportReference", () => {
    it("formats deterministic uppercase RPT- references stripping hyphens", () => {
      expect(
        formatReportReference("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      ).toBe("RPT-A1B2C3D4");
    });
  });

  describe("POST /api/report authorization and reference response", () => {
    const reviewId = "550e8400-e29b-41d4-a716-446655440000";
    const authorUserId = "550e8400-e29b-41d4-a716-446655440001";
    const consultantUserId = "550e8400-e29b-41d4-a716-446655440002";
    const bystanderUserId = "550e8400-e29b-41d4-a716-446655440003";

    it("rejects third-party review reports when caller is neither reviewed consultant nor host org member", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: bystanderUserId, role: "CONSULTANT" },
      });
      mockConsultantReview.findFirst.mockResolvedValue({
        id: reviewId,
        reviewDescription: "Unfair review",
        consulteeProfile: { userId: authorUserId },
        consultantProfile: { userId: consultantUserId },
        appointment: { organizationId: null },
      });

      const req = new NextRequest("http://localhost/api/report", {
        method: "POST",
        body: JSON.stringify({
          type: "REVIEW",
          reason: "HARASSMENT_OR_ABUSE",
          reviewId,
          targetUserId: authorUserId,
        }),
      });

      const res = await postReport(req);
      expect(res.status).toBe(403);
    });

    it("returns deterministic reportReference when reviewed consultant reports a review", async () => {
      const createdReportId = "12345678-90ab-cdef-1234-567890abcdef";
      mockGetSession.mockResolvedValue({
        user: { id: consultantUserId, role: "CONSULTANT" },
      });
      mockConsultantReview.findFirst.mockResolvedValue({
        id: reviewId,
        reviewDescription: "Unfair review",
        consulteeProfile: { userId: authorUserId },
        consultantProfile: { userId: consultantUserId },
        appointment: { organizationId: null },
      });
      mockModerationReport.findFirst.mockResolvedValue(null);
      mockModerationReport.create.mockResolvedValue({
        id: createdReportId,
        type: "REVIEW",
        status: "PENDING",
      });

      const req = new NextRequest("http://localhost/api/report", {
        method: "POST",
        body: JSON.stringify({
          type: "REVIEW",
          reason: "HARASSMENT_OR_ABUSE",
          reviewId,
          targetUserId: authorUserId,
        }),
      });

      const res = await postReport(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.reportReference).toBe("RPT-12345678");
    });
  });

  describe("GET /api/user/reports privacy and pagination", () => {
    it("returns reporter-safe fields with deterministic reference and never leaks staff notes", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: "reporter-1", role: "CONSULTANT" },
      });
      mockModerationReport.findMany.mockResolvedValue([
        {
          id: "abcdef12-3456-7890-abcd-ef1234567890",
          type: "REVIEW",
          status: "DISMISSED",
          createdAt: new Date("2026-10-01T10:00:00Z"),
          resolvedAt: new Date("2026-10-02T12:00:00Z"),
          actions: [{ actionType: "NO_ACTION" }],
        },
        {
          id: "fedcba98-7654-3210-fedc-ba9876543210",
          type: "REVIEW",
          status: "ACTION_TAKEN",
          createdAt: new Date("2026-10-03T10:00:00Z"),
          resolvedAt: new Date("2026-10-04T12:00:00Z"),
          actions: [{ actionType: "CONTENT_REMOVED" }],
        },
      ]);
      mockModerationReport.count.mockResolvedValue(2);

      const req = new NextRequest(
        "http://localhost/api/user/reports?page=1&limit=10",
      );
      const res = await getUserReports(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reports).toEqual([
        {
          reportId: "abcdef12-3456-7890-abcd-ef1234567890",
          reference: "RPT-ABCDEF12",
          type: "REVIEW",
          status: "DISMISSED",
          createdAt: "2026-10-01T10:00:00.000Z",
          resolvedAt: "2026-10-02T12:00:00.000Z",
          outcome: "NO_ACTION_TAKEN",
        },
        {
          reportId: "fedcba98-7654-3210-fedc-ba9876543210",
          reference: "RPT-FEDCBA98",
          type: "REVIEW",
          status: "ACTION_TAKEN",
          createdAt: "2026-10-03T10:00:00.000Z",
          resolvedAt: "2026-10-04T12:00:00.000Z",
          outcome: "CONTENT_REMOVED",
        },
      ]);
      expect(body.reports[0]).not.toHaveProperty("notes");
      expect(body.reports[0]).not.toHaveProperty("actions");
    });
  });

  describe("readReviewReportSignals and readReviewReportContext", () => {
    it("batches signals cleanly and builds factual timing signals without accusations", async () => {
      const emptySignals = await readReviewReportSignals([]);
      expect(Object.keys(emptySignals)).toHaveLength(0);
      expect(mockRefund.findMany).not.toHaveBeenCalled();

      mockRefund.findMany.mockResolvedValue([
        { payment: { appointmentId: "apt-1" } },
      ]);
      mockAppointmentSupportThread.findMany.mockResolvedValue([
        { appointmentId: "apt-2" },
      ]);
      mockDispute.findMany.mockResolvedValue([]);

      const signals = await readReviewReportSignals(["apt-1", "apt-2"]);
      expect(signals["apt-1"]).toEqual({
        hasRefund: true,
        hasOpenTicket: false,
        hasDispute: false,
      });
      expect(signals["apt-2"]).toEqual({
        hasRefund: false,
        hasOpenTicket: true,
        hasDispute: false,
      });

      mockAppointment.findUnique.mockResolvedValue({
        id: "apt-1",
        occurrences: [{ completionStatus: "COMPLETED" }],
        consultantReviews: [{ createdAt: new Date("2026-10-07T10:00:00Z") }],
        supportThreads: [{ id: "thread-open-1" }],
        payment: [
          {
            refunds: [
              {
                id: "ref-1",
                status: "SUCCEEDED",
                updatedAt: new Date("2026-10-05T10:00:00Z"),
              },
            ],
            disputes: [],
          },
        ],
      });

      const detailContext = await readReviewReportContext("apt-1");
      expect(detailContext).toEqual({
        appointmentId: "apt-1",
        appointmentStatus: "COMPLETED",
        refundCount: 1,
        latestRefundStatus: "SUCCEEDED",
        hasDispute: false,
        openSupportCount: 1,
        signals: [
          "Review posted within 2 days of refund decision",
          "Open support case on this booking",
        ],
      });
    });
  });

  describe("PATCH /api/staff/moderation/reports/[reportId] terminal state guard", () => {
    it("rejects DISMISSED and ACTION_TAKEN on PATCH so resolutions must use POST .../action", async () => {
      mockRequirePrivilegedAuth.mockResolvedValue({
        session: { user: { id: "staff-1", role: "STAFF" } },
      });

      for (const terminalStatus of ["DISMISSED", "ACTION_TAKEN"]) {
        const req = new NextRequest(
          "http://localhost/api/staff/moderation/reports/rep-1",
          {
            method: "PATCH",
            body: JSON.stringify({ status: terminalStatus }),
          },
        );
        const res = await patchModerationReport(req, {
          params: Promise.resolve({ reportId: "rep-1" }),
        });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("PATCH /api/staff/moderation/reports/[reportId] resolved and stale guards", () => {
    const patch = (body: object) =>
      patchModerationReport(
        new NextRequest("http://localhost/api/staff/moderation/reports/rep-1", {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ reportId: "rep-1" }) },
      );

    beforeEach(() => {
      mockRequirePrivilegedAuth.mockResolvedValue({
        session: { user: { id: "staff-1", role: "STAFF" } },
      });
      mockModerationReport.updateMany.mockReset();
    });

    it("refuses to reopen a resolved report and leaves it untouched", async () => {
      mockModerationReport.findUnique.mockResolvedValueOnce({
        id: "rep-1",
        status: "ACTION_TAKEN",
        assignedToId: null,
      });
      const res = await patch({
        status: "PENDING",
        expectedStatus: "ACTION_TAKEN",
        expectedAssignedToId: null,
      });
      expect(res.status).toBe(409);
      expect(mockModerationReport.updateMany).not.toHaveBeenCalled();
    });

    it("answers 409 on a stale expectedStatus and 400 without expectations", async () => {
      mockModerationReport.findUnique.mockResolvedValueOnce({
        id: "rep-1",
        status: "UNDER_REVIEW",
        assignedToId: null,
      });
      mockModerationReport.updateMany.mockResolvedValueOnce({ count: 0 });
      const stale = await patch({
        status: "ESCALATED",
        expectedStatus: "PENDING",
        expectedAssignedToId: null,
      });
      expect(stale.status).toBe(409);
      expect((await patch({ status: "ESCALATED" })).status).toBe(400);
    });
  });

  describe("Moderation side-effects reporter disposition & target notice copy", () => {
    it("stages reporter disposition bell inside tx and sends non-threatening content removal copy with per-action dedupeKey", async () => {
      mockConsultantReview.findUnique.mockResolvedValue({
        consultantProfileId: "prof-1",
        deletedAt: null,
        removedBy: null,
      });
      mockConsultantReview.updateMany.mockResolvedValue({
        count: 1,
      });

      const input = {
        actionId: "act-999",
        actionType: "CONTENT_REMOVED" as const,
        staffUserId: "staff-1",
        report: {
          id: "11223344-5566-7788-99aa-bbccddeeff00",
          type: "REVIEW" as const,
          reportedById: "reporter-user-1",
          targetUserId: "author-user-1",
          reviewId: "rev-1",
        },
      };

      const txResult = await applyTransactionalEffects(prisma, input);
      expect(mockStageTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: NOVU_WORKFLOWS.MODERATION_REPORT_OUTCOME,
          recipients: ["reporter-user-1"],
          dedupeKey:
            "report-disposition:11223344-5566-7788-99aa-bbccddeeff00:act-999",
          payload: expect.objectContaining({
            reference: "RPT-11223344",
            outcome: "decided: action taken",
          }),
        }),
      );
      expect(mockStageTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: NOVU_WORKFLOWS.CONTENT_REMOVED_NOTICE,
          recipients: ["author-user-1"],
          dedupeKey: "content-removed:act-999",
        }),
      );

      await applyBestEffortEffects(input, txResult);
      expect(mockNotifyModerationWarning).not.toHaveBeenCalled();
    });
  });

  describe("review exclusion notice recipients", () => {
    const exclusion = (reportedById: string) => ({
      actionId: "act-ex",
      actionType: "REVIEW_EXCLUDED_FROM_AGGREGATE" as const,
      staffUserId: "staff-1",
      report: {
        id: "aabbccdd-0000-0000-0000-000000000000",
        type: "REVIEW" as const,
        reportedById,
        targetUserId: "author-user-1",
        reviewId: "rev-1",
      },
    });
    const staged = () =>
      mockStageTrigger.mock.calls.map(
        ([a]: [{ workflowId: string; recipients: string[] }]) =>
          `${a.workflowId}>${a.recipients.join(",")}`,
      );

    beforeEach(() => {
      mockStageTrigger.mockClear();
      mockNotifyModerationWarning.mockClear();
      mockConsultantReview.findUnique.mockResolvedValue({
        consultantProfileId: "prof-1",
        consultantProfile: { userId: "expert-1" },
      });
    });

    it("notifies the expert and a separate reporter, never the author", async () => {
      mockConsultantReview.updateMany.mockResolvedValue({ count: 1 });
      const input = exclusion("reporter-2");
      const tx = await applyTransactionalEffects(prisma, input);
      expect(staged()).toEqual([
        `${NOVU_WORKFLOWS.REVIEW_EXCLUDED_FROM_RATING}>expert-1`,
        `${NOVU_WORKFLOWS.MODERATION_REPORT_OUTCOME}>reporter-2`,
      ]);
      await applyBestEffortEffects(input, tx);
      expect(mockNotifyModerationWarning).not.toHaveBeenCalled();
    });

    it("sends one message when the expert filed the report", async () => {
      mockConsultantReview.updateMany.mockResolvedValue({ count: 1 });
      await applyTransactionalEffects(prisma, exclusion("expert-1"));
      expect(staged()).toEqual([
        `${NOVU_WORKFLOWS.REVIEW_EXCLUDED_FROM_RATING}>expert-1`,
      ]);
    });

    it("stages nothing when the exclusion CAS loses (409)", async () => {
      mockConsultantReview.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        applyTransactionalEffects(prisma, exclusion("reporter-2")),
      ).rejects.toMatchObject({ httpStatus: 409 });
      expect(staged()).toEqual([]);
    });
  });

  describe("GET /api/appointments/[appointmentId]/feedback supportOpen signal", () => {
    it("returns supportOpen=true when an unresolved AppointmentSupportThread exists", async () => {
      mockAuthorizeAppointment.mockResolvedValue({
        userId: "consultee-1",
        detail: {
          appointment: { id: "550e8400-e29b-41d4-a716-446655440010" },
        },
      });
      mockAppointmentOccurrence.findMany.mockResolvedValue([]);
      mockAppointmentFeedback.findMany.mockResolvedValue([]);
      // Only consultee-1's own thread is open; another attendee's is not visible.
      mockAppointmentSupportThread.findFirst.mockImplementation(
        async ({ where }: { where: { userId: string } }) =>
          where.userId === "consultee-1" ? { id: "thread-1" } : null,
      );

      const req = new NextRequest(
        "http://localhost/api/appointments/550e8400-e29b-41d4-a716-446655440010/feedback",
      );
      const res = await getSessionFeedback(req, {
        params: Promise.resolve({
          appointmentId: "550e8400-e29b-41d4-a716-446655440010",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.supportOpen).toBe(true);

      mockAuthorizeAppointment.mockResolvedValue({
        userId: "attendee-2",
        detail: {
          appointment: { id: "550e8400-e29b-41d4-a716-446655440010" },
        },
      });
      const other = await getSessionFeedback(req, {
        params: Promise.resolve({
          appointmentId: "550e8400-e29b-41d4-a716-446655440010",
        }),
      });
      expect((await other.json()).supportOpen).toBe(false);
    });
  });

  describe("PATCH /api/staff/feedbacks/[feedbackId] CAS & outbox notification", () => {
    it("returns 409 on concurrent status mutation and stages PLATFORM_FEEDBACK_UPDATE bell on transition", async () => {
      mockRequirePrivilegedAuth.mockResolvedValue({
        session: { user: { id: "staff-1", role: "STAFF" } },
      });

      mockPlatformFeedback.findUnique.mockResolvedValueOnce({
        id: "fb-1",
        status: "PENDING",
        userId: "author-1",
      });
      mockPlatformFeedback.updateMany.mockResolvedValueOnce({
        count: 0,
      });

      const raceReq = new NextRequest(
        "http://localhost/api/staff/feedbacks/fb-1",
        {
          method: "PATCH",
          body: JSON.stringify({ status: "IN_PROGRESS" }),
        },
      );
      const raceRes = await patchStaffFeedback(raceReq, {
        params: Promise.resolve({ feedbackId: "fb-1" }),
      });
      expect(raceRes.status).toBe(409);

      mockPlatformFeedback.findUnique.mockResolvedValueOnce({
        id: "fb-1",
        status: "PENDING",
        userId: "author-1",
      });
      mockPlatformFeedback.updateMany.mockResolvedValueOnce({
        count: 1,
      });
      mockPlatformFeedback.findUniqueOrThrow.mockResolvedValueOnce({
        id: "fb-1",
        status: "RESOLVED",
        user: {
          id: "author-1",
          name: "Asha",
          email: "asha@example.com",
          image: null,
        },
      });

      const okReq = new NextRequest(
        "http://localhost/api/staff/feedbacks/fb-1",
        {
          method: "PATCH",
          body: JSON.stringify({ status: "RESOLVED" }),
        },
      );
      const okRes = await patchStaffFeedback(okReq, {
        params: Promise.resolve({ feedbackId: "fb-1" }),
      });
      expect(okRes.status).toBe(200);
      expect(mockStageTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: NOVU_WORKFLOWS.PLATFORM_FEEDBACK_UPDATE,
          recipients: ["author-1"],
          dedupeKey: expect.stringMatching(
            /^platform-feedback:fb-1:PENDING->RESOLVED:\d+$/,
          ),
        }),
      );
      expect(mockAttemptTrigger).toHaveBeenCalled();
    });
  });
});
