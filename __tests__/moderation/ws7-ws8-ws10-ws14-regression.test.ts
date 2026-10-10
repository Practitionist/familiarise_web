/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockModerationReport = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};
const mockConsultantReview = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};
const mockMembership = {
  findFirst: jest.fn(),
  findMany: jest.fn().mockResolvedValue([]),
};
const mockUser = {
  findUnique: jest.fn().mockResolvedValue({ id: "reviewer-user" }),
  findFirst: jest.fn(),
};
const mockDispute = {
  findUnique: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};
const mockAppointment = {
  findMany: jest.fn(),
};
const mockSupportTicket = {
  create: jest.fn(),
};
const mockTransaction = jest.fn();

const mockGetSession = jest.fn();
const mockRequireApiAuth = jest.fn();
const mockRequirePrivilegedAuth = jest.fn();
const mockApplyRateLimit = jest.fn().mockResolvedValue(null);
const mockPurgeReviewSurfaces = jest.fn();
const mockAllocateTicketReference = jest.fn();
const mockSendContactInquiryEmail = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    get moderationReport() {
      return mockModerationReport;
    },
    get consultantReview() {
      return mockConsultantReview;
    },
    get membership() {
      return mockMembership;
    },
    get user() {
      return mockUser;
    },
    get dispute() {
      return mockDispute;
    },
    get appointment() {
      return mockAppointment;
    },
    get supportTicket() {
      return mockSupportTicket;
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/auth-helpers", () => {
  const actual = jest.requireActual("../../lib/auth-helpers");
  return {
    ...actual,
    requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
    requirePrivilegedAuth: (...args: unknown[]) =>
      mockRequirePrivilegedAuth(...args),
  };
});

jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
  getClientIp: () => "127.0.0.1",
  spamLimiter: { name: "spamLimiter" },
  reportLimiter: { name: "reportLimiter" },
  reviewWriteLimiter: { name: "reviewWriteLimiter" },
}));

jest.mock("../../lib/data/public-cache", () => ({
  purgeReviewSurfaces: (...args: unknown[]) => mockPurgeReviewSurfaces(...args),
}));

jest.mock("../../lib/support/reference", () => ({
  allocateTicketReference: (...args: unknown[]) =>
    mockAllocateTicketReference(...args),
}));

jest.mock("../../lib/email", () => ({
  sendContactInquiryEmail: (...args: unknown[]) =>
    mockSendContactInquiryEmail(...args),
}));

import {
  CreateReportSchema,
  PatchReportSchema,
  PatchFeedbackSchema,
  REVIEW_REPORT_REASONS,
} from "../../schemas/moderation";
import { moderationStatementOfReasons } from "../../lib/moderation/side-effects";
import {
  ACK_PROMISE_COPY,
  ANTI_SCAM_NOTICE,
  COMPANY_INFO,
  GRIEVANCE_OFFICER,
  INQUIRY_CATEGORIES,
  POLICY_DATES,
} from "../../app/(pages)/constants";
import { POST as createReportRoute } from "../../app/api/report/route";
import { POST as postContactRoute } from "../../app/api/contact/route";
import { PATCH as patchReportRoute } from "../../app/api/staff/moderation/reports/[reportId]/route";
import { DELETE as deleteReviewModerationRoute } from "../../app/api/staff/moderation/reviews/[reviewId]/route";
import { GET as getAdminDisputesListRoute } from "../../app/api/admin/disputes/route";
import { GET as getAdminDisputeRoute } from "../../app/api/admin/disputes/[disputeId]/route";
import {
  PUT as putUserReviewRoute,
  DELETE as deleteUserReviewRoute,
} from "../../app/api/user/reviews/[id]/route";
import { GET as getReviewableSessionsRoute } from "../../app/api/user/reviews/reviewable-sessions/route";

describe("Moderation, Disputes, Compliance & Reviews regressions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyRateLimit.mockResolvedValue(null);
    mockTransaction.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          moderationReport: mockModerationReport,
          consultantReview: mockConsultantReview,
          moderationAction: { create: jest.fn() },
          consultantProfile: { update: jest.fn() },
          user: mockUser,
          supportTicket: mockSupportTicket,
        }),
    );
  });

  test("Moderation Zod schemas enforce allowed status transitions and review report reasons", () => {
    expect(
      REVIEW_REPORT_REASONS.some((r) => r.value === "COERCION_OR_RETALIATION"),
    ).toBe(true);
    expect(
      PatchReportSchema.safeParse({
        status: "DISMISSED",
        expectedStatus: "PENDING",
        expectedAssignedToId: null,
      }).success,
    ).toBe(false);
    expect(
      PatchReportSchema.safeParse({
        status: "ACTION_TAKEN",
        expectedStatus: "PENDING",
        expectedAssignedToId: null,
      }).success,
    ).toBe(false);
    expect(
      PatchReportSchema.safeParse({ status: "UNDER_REVIEW" }).success,
    ).toBe(true);
    expect(
      PatchFeedbackSchema.safeParse({ status: "ACKNOWLEDGED" }).success,
    ).toBe(true);
    expect(
      CreateReportSchema.safeParse({
        type: "REVIEW",
        targetUserId: "user-2",
        reviewId: "rev-1",
        reason: "COERCION_OR_RETALIATION",
        description: "Threatened refund chargeback",
      }).success,
    ).toBe(true);
    expect(
      CreateReportSchema.safeParse({
        type: "REVIEW",
        targetUserId: "user-2",
        reviewId: "rev-1",
        reason: "INVALID_REASON",
        description: "Arbitrary non-enum reason",
      }).success,
    ).toBe(false);
  });

  test("PATCH /api/staff/moderation/reports/[reportId] rejects terminal status writes", async () => {
    mockRequirePrivilegedAuth.mockResolvedValue({
      session: { user: { id: "staff-1", role: "STAFF" } },
    });

    const req = new NextRequest(
      "http://localhost/api/staff/moderation/reports/rep-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "DISMISSED",
          expectedStatus: "PENDING",
          expectedAssignedToId: null,
        }),
      },
    );
    const res = await patchReportRoute(req, {
      params: Promise.resolve({ reportId: "rep-1" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/report enforces consultant or host OWNER/MAINTAINER gate on reviews and appends subsequent reporter statement", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "outsider-user", role: "CONSULTEE" },
    });
    mockConsultantReview.findFirst.mockResolvedValue({
      id: "rev-1",
      deletedAt: null,
      reviewDescription: "Unfair review",
      rating: 1,
      appointment: { organizationId: "org-1" },
      consultantProfile: { userId: "consultant-user" },
      consulteeProfile: { userId: "reviewer-user" },
    });
    mockMembership.findFirst.mockResolvedValue(null);

    const forbiddenReq = new NextRequest("http://localhost/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "REVIEW",
        targetUserId: "reviewer-user",
        reviewId: "rev-1",
        reason: "SPAM_OR_FAKE",
        description: "Outsider attempt",
      }),
    });
    const forbiddenRes = await createReportRoute(forbiddenReq);
    expect(forbiddenRes.status).toBe(403);

    mockGetSession.mockResolvedValue({
      user: { id: "org-admin-user", role: "CONSULTANT" },
    });
    mockMembership.findFirst.mockResolvedValue({ id: "mem-1" });
    mockModerationReport.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rep-open-1",
        reportCount: 1,
        description: "First reporter statement",
        contentText: "Unfair review",
      });
    mockModerationReport.updateMany.mockResolvedValue({ count: 1 });

    const secondReq = new NextRequest("http://localhost/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "REVIEW",
        targetUserId: "reviewer-user",
        reviewId: "rev-1",
        reason: "COERCION_OR_RETALIATION",
        description: "Demanded refund to remove 1-star",
      }),
    });
    const secondRes = await createReportRoute(secondReq);
    expect(secondRes.status).toBe(200);
    expect(mockModerationReport.updateMany).toHaveBeenCalledWith({
      where: {
        id: "rep-open-1",
        reportCount: 1,
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
      data: {
        reportCount: { increment: 1 },
        description:
          "First reporter statement\nReporter 2 (COERCION_OR_RETALIATION): Demanded refund to remove 1-star",
      },
    });
  });

  test("DELETE /api/staff/moderation/reviews/[reviewId] returns alreadyRemoved without re-purging cache", async () => {
    mockRequirePrivilegedAuth.mockResolvedValue({
      session: { user: { id: "admin-1", role: "ADMIN" } },
    });
    mockConsultantReview.findUnique.mockResolvedValue({
      consultantProfileId: "cp-1",
    });
    mockConsultantReview.updateMany.mockResolvedValue({ count: 0 });

    const req = new NextRequest(
      "http://localhost/api/staff/moderation/reviews/rev-1",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Duplicate takedown check" }),
      },
    );
    const res = await deleteReviewModerationRoute(req, {
      params: Promise.resolve({ reviewId: "rev-1" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.alreadyRemoved).toBe(true);
    expect(mockPurgeReviewSurfaces).not.toHaveBeenCalled();
  });

  test("moderationStatementOfReasons states policy ground, human review, and appeal reference without leaking internal staff notes", () => {
    const notice = moderationStatementOfReasons({
      actionType: "CONTENT_REMOVED",
      reportId: "abcdef123456",
      reportReason: "COERCION_OR_RETALIATION",
    });
    expect(notice).toContain("Coercion, extortion, or retaliatory pressure");
    expect(notice).toContain("human moderator");
    expect(notice).toContain("no automated decision was used");
    expect(notice).toContain("RPT-ABCDEF12");
    expect(notice).not.toContain("Details:");
  });

  test("GET /api/admin/disputes/[disputeId] builds structured read-only evidencePack and sanitizes raw attendance userIds", async () => {
    mockRequirePrivilegedAuth.mockResolvedValue({
      session: { user: { id: "admin-1", role: "ADMIN" } },
    });

    mockDispute.findUnique.mockResolvedValue({
      id: "disp-1",
      disputeId: "rzp_disp_1",
      amountPaise: 150000,
      currency: "INR",
      status: "NEEDS_RESPONSE",
      reason: "Service not rendered",
      paymentGateway: "RAZORPAY",
      paymentId: "pay-1",
      dueBy: new Date("2026-10-12T00:00:00Z"),
      isChargeRefundable: true,
      evidence: null,
      evidenceSubmittedAt: null,
      createdAt: new Date("2026-10-10T00:00:00Z"),
      updatedAt: new Date("2026-10-10T00:00:00Z"),
      payment: {
        id: "pay-1",
        paymentIntent: "pi_1",
        paymentStatus: "SUCCEEDED",
        amount: 150000,
        currency: "INR",
        paymentMethod: "CARD",
        createdAt: new Date("2026-10-01T09:00:00Z"),
        user: { id: "user-1", name: "Customer One", email: "c1@example.com" },
        appointment: {
          id: "appt-1",
          appointmentType: "CONSULTATION",
          createdAt: new Date("2026-10-01T09:00:00Z"),
          occurrences: [
            {
              id: "occ-1",
              startsAt: new Date("2026-10-01T10:00:00Z"),
              endsAt: new Date("2026-10-01T11:00:00Z"),
              completionStatus: "UNVERIFIED",
              outcome: null,
              attendances: [],
            },
          ],
          supportThreads: [],
          supportCases: [
            {
              id: "case-1",
              status: "OPEN",
              category: "billing",
              referenceNumber: "FAM-2026-000001",
              priority: "HIGH",
              createdAt: new Date("2026-10-02T09:00:00Z"),
            },
          ],
        },
      },
    });

    const req = new NextRequest("http://localhost/api/admin/disputes/disp-1");
    const res = await getAdminDisputeRoute(req, {
      params: Promise.resolve({ disputeId: "disp-1" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.evidencePack).toBeDefined();
    expect(body.evidencePack.booking.appointmentId).toBe("appt-1");
    expect(body.evidencePack.attendance.recordsFound).toBe(false);
    expect(body.evidencePack.attendance.summary).toContain(
      "No meeting attendance telemetry records were recorded",
    );
    expect(body.evidencePack.supportHistory.ticketCount).toBe(1);
    expect(body.evidencePack.supportHistory.openCount).toBe(1);
    expect(body.payment.appointment.occurrences[0].attendances).toBeUndefined();
    expect(body.payment.appointment.supportThreads).toBeUndefined();
    expect(body.payment.appointment.supportCases).toBeUndefined();
  });

  test("counts urgentDisputes strictly across ACTIONABLE_OPEN_STATUSES (SFR-05-20)", async () => {
    mockRequirePrivilegedAuth.mockResolvedValue({
      session: { user: { id: "admin-1", role: "ADMIN" } },
    });

    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const fixtures = [
      {
        id: "disp-open-soon",
        status: "NEEDS_RESPONSE",
        dueBy: new Date(nowMs + 2 * dayMs),
      },
      {
        id: "disp-warning-overdue",
        status: "WARNING_NEEDS_RESPONSE",
        dueBy: new Date(nowMs - 2 * dayMs),
      },
      {
        id: "disp-review-overdue",
        status: "UNDER_REVIEW",
        dueBy: new Date(nowMs - 2 * dayMs),
      },
    ];

    mockDispute.count.mockImplementation(
      async ({ where }: { where?: Record<string, unknown> }) => {
        if (!where || Object.keys(where).length === 0) {
          return fixtures.length;
        }
        return fixtures.filter((item) => {
          const statusFilter = where.status;
          if (
            typeof statusFilter === "string" &&
            item.status !== statusFilter
          ) {
            return false;
          }
          if (
            statusFilter &&
            typeof statusFilter === "object" &&
            "in" in statusFilter &&
            Array.isArray(statusFilter.in) &&
            !statusFilter.in.includes(item.status)
          ) {
            return false;
          }
          const dueByFilter = where.dueBy;
          if (
            dueByFilter &&
            typeof dueByFilter === "object" &&
            "lte" in dueByFilter &&
            dueByFilter.lte instanceof Date &&
            item.dueBy.getTime() > dueByFilter.lte.getTime()
          ) {
            return false;
          }
          return true;
        }).length;
      },
    );
    mockDispute.findMany.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/admin/disputes");
    const res = await getAdminDisputesListRoute(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.urgentDisputes).toBe(2);
    expect(body.stats.underReviewCount).toBe(1);
  });

  test("Compliance constants publish Grievance Officer details and 24-hour acknowledgment without placeholders or invented values", () => {
    expect(ACK_PROMISE_COPY).toBe("within 24 hours");
    expect(COMPANY_INFO.name).toBe("Practitionist (OPC) Private Limited");
    expect(COMPANY_INFO.jurisdiction).toBe("Haryana, India");
    if (!process.env.CONTACT_INBOX_ADDRESS) {
      expect(COMPANY_INFO.email).toBe("support@practitionist.com");
      expect(GRIEVANCE_OFFICER.email).toBe("support@practitionist.com");
    }
    expect(ANTI_SCAM_NOTICE).toContain("never ask for your OTP");
    expect(INQUIRY_CATEGORIES.some((c) => c.value === "grievance")).toBe(true);
    const dumped = JSON.stringify({
      COMPANY_INFO,
      GRIEVANCE_OFFICER,
      POLICY_DATES,
    });
    expect(dumped).not.toMatch(/\[[A-Z0-9_ ]+\]/);
    expect(dumped).not.toContain("+91-80-4710-8000");
    expect(dumped).not.toContain("Bengaluru");
    if (!process.env.CONTACT_INBOX_ADDRESS) {
      expect(dumped).not.toContain("familiarisenow.com");
    }
  });

  test("POST /api/contact creates SupportTicket in the same transaction as allocateTicketReference for public grievances and skips allocation when zero operators exist", async () => {
    mockGetSession.mockResolvedValue(null);
    mockUser.findFirst.mockResolvedValueOnce({ id: "operator-admin-1" });
    mockAllocateTicketReference.mockResolvedValueOnce("FAM-2026-000042");
    mockSupportTicket.create.mockResolvedValueOnce({
      id: "ticket-42",
      referenceNumber: "FAM-2026-000042",
    });
    mockSendContactInquiryEmail.mockResolvedValue({
      success: true,
      staged: true,
    });

    const grievanceReq = new NextRequest("http://localhost/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Asha",
        lastName: "Verma",
        email: "asha@example.com",
        subject: "Unresolved billing dispute",
        message: "Please review my double charge urgently.",
        category: "grievance",
      }),
    });

    const grievanceRes = await postContactRoute(grievanceReq);
    const grievanceBody = await grievanceRes.json();

    expect(grievanceRes.status).toBe(202);
    expect(grievanceBody).toEqual({
      ok: true,
      referenceNumber: "FAM-2026-000042",
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockAllocateTicketReference).toHaveBeenCalledTimes(1);
    expect(mockSupportTicket.create).toHaveBeenCalledTimes(1);
    expect(mockSupportTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referenceNumber: "FAM-2026-000042",
          title: "[Grievance] Unresolved billing dispute",
          category: "GRIEVANCE",
          status: "OPEN",
          priority: "HIGH",
          userId: "operator-admin-1",
        }),
      }),
    );

    mockAllocateTicketReference.mockClear();
    mockSupportTicket.create.mockClear();
    mockUser.findFirst.mockResolvedValueOnce(null);

    const noOperatorReq = new NextRequest("http://localhost/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Asha",
        lastName: "Verma",
        email: "asha@example.com",
        subject: "Unresolved billing dispute",
        message: "Please review my double charge urgently.",
        category: "grievance",
      }),
    });

    const noOperatorRes = await postContactRoute(noOperatorReq);
    const noOperatorBody = await noOperatorRes.json();

    expect(noOperatorRes.status).toBe(202);
    expect(noOperatorBody).toEqual({
      ok: true,
      referenceNumber: null,
      message:
        "Grievance received — our Grievance Officer will open a case and email your tracking reference within 24 hours.",
    });
    expect(mockAllocateTicketReference).not.toHaveBeenCalled();
    expect(mockSupportTicket.create).not.toHaveBeenCalled();
  });

  test("POST /api/report preserves newest reporter statement when aggregated description exceeds 4000 chars", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "org-admin-user", role: "CONSULTANT" },
    });
    mockConsultantReview.findFirst.mockResolvedValue({
      id: "rev-long",
      deletedAt: null,
      reviewDescription: "Long history review",
      rating: 1,
      appointment: { organizationId: "org-1" },
      consultantProfile: { userId: "consultant-user" },
      consulteeProfile: { userId: "reviewer-user" },
    });
    mockMembership.findFirst.mockResolvedValue({ id: "mem-1" });
    mockModerationReport.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rep-open-long",
        reportCount: 15,
        description: "A".repeat(3990),
        contentText: "Long history review",
      });
    mockModerationReport.updateMany.mockResolvedValue({ count: 1 });

    const req = new NextRequest("http://localhost/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "REVIEW",
        targetUserId: "reviewer-user",
        reviewId: "rev-long",
        reason: "HARASSMENT_OR_ABUSE",
        description: "Latest reporter statement must never be truncated away",
      }),
    });
    const res = await createReportRoute(req);
    expect(res.status).toBe(200);

    const writtenDescription: string =
      mockModerationReport.updateMany.mock.calls[0][0].data.description;
    expect(writtenDescription.length).toBe(4000);
    expect(
      writtenDescription.endsWith(
        "\nReporter 16 (HARASSMENT_OR_ABUSE): Latest reporter statement must never be truncated away",
      ),
    ).toBe(true);
  });

  test("PUT and DELETE on /api/user/reviews/[id] share reviewWriteLimiter and repeat author DELETE returns 200", async () => {
    mockRequireApiAuth.mockResolvedValue({
      session: {
        user: {
          id: "consultee-user-1",
          role: "CONSULTEE",
          consulteeProfileId: "consultee-profile-1",
        },
      },
    });
    mockConsultantReview.findUnique.mockResolvedValue({
      id: "rev-1",
      consulteeProfileId: "consultee-profile-1",
      consultantProfileId: "cp-1",
      deletedAt: new Date("2026-10-09T00:00:00Z"),
      removedBy: "AUTHOR",
    });

    const delReq = new NextRequest("http://localhost/api/user/reviews/rev-1", {
      method: "DELETE",
    });
    const delRes = await deleteUserReviewRoute(delReq, {
      params: Promise.resolve({ id: "rev-1" }),
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ message: "Review withdrawn" });
    expect(mockApplyRateLimit).toHaveBeenCalledWith(
      { name: "reviewWriteLimiter" },
      "reviews:consultee-user-1",
    );

    mockApplyRateLimit.mockClear();
    const putReq = new NextRequest("http://localhost/api/user/reviews/rev-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 5 }),
    });
    await putUserReviewRoute(putReq, {
      params: Promise.resolve({ id: "rev-1" }),
    });
    expect(mockApplyRateLimit).toHaveBeenCalledWith(
      { name: "reviewWriteLimiter" },
      "reviews:consultee-user-1",
    );
  });

  test("GET /api/user/reviews/reviewable-sessions?unreviewed=1 excludes already-reviewed sessions", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "consultee-user-1",
        consulteeProfileId: "consultee-profile-1",
      },
    });
    mockAppointment.findMany.mockResolvedValue([
      {
        id: "appt-reviewed",
        appointmentType: "CONSULTATION",
        webinarId: null,
        classId: null,
        organizationId: null,
        consultation: {
          consultationPlan: {
            title: "Reviewed Session",
            consultantProfileId: "cp-1",
            consultantProfile: { user: { name: "Expert One" } },
          },
        },
        subscription: null,
        trial: null,
        webinar: null,
        class: null,
        occurrences: [{ endsAt: new Date("2026-10-08T10:00:00Z") }],
      },
      {
        id: "appt-unreviewed",
        appointmentType: "CONSULTATION",
        webinarId: null,
        classId: null,
        organizationId: null,
        consultation: {
          consultationPlan: {
            title: "Unreviewed Session",
            consultantProfileId: "cp-2",
            consultantProfile: { user: { name: "Expert Two" } },
          },
        },
        subscription: null,
        trial: null,
        webinar: null,
        class: null,
        occurrences: [{ endsAt: new Date("2026-10-09T10:00:00Z") }],
      },
    ]);
    mockConsultantReview.findMany.mockResolvedValue([
      {
        id: "rev-existing",
        rating: 5,
        reviewDescription: "Great!",
        ratingCause: null,
        isAnonymous: false,
        consultantProfileId: "cp-1",
        track: "ONE_TO_ONE",
        ratingUnitId: null,
      },
    ]);

    const req = new NextRequest(
      "http://localhost/api/user/reviews/reviewable-sessions?unreviewed=1",
    );
    const res = await getReviewableSessionsRoute(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].appointmentId).toBe("appt-unreviewed");
    expect(body.data[0].reviewed).toBe(false);
  });
});
