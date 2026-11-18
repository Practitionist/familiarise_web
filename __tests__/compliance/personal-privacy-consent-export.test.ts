/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
}));

const mockWithdrawConsent = jest.fn();
jest.mock("../../lib/compliance/dpdp", () => {
  const actual = jest.requireActual("../../lib/compliance/dpdp");
  return {
    ...actual,
    withdrawConsent: (...args: unknown[]) => mockWithdrawConsent(...args),
  };
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: {
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    notificationPreference: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    cookiePreference: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(async () => ({ email: "User@Example.com" })),
    },
    newsletterSubscriber: {
      upsert: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      updateManyAndReturn: jest.fn(async () => []),
    },
    payment: {
      findMany: jest.fn(),
    },
    supportCase: {
      findMany: jest.fn(),
    },
    supportCaseMessage: { findMany: jest.fn(async () => []) },
    supportCaseEvidenceRequest: { findMany: jest.fn(async () => []) },
    supportCaseAttachment: { findMany: jest.fn(async () => []) },
    supportCaseChatAccess: { findMany: jest.fn(async () => []) },
    membership: {
      findMany: jest.fn(),
    },
    dpdpGrievance: {
      findMany: jest.fn(),
    },
    consumerInvoice: {
      findMany: jest.fn(),
    },
    appointmentParticipant: {
      findMany: jest.fn(),
    },
    collaborator: {
      findMany: jest.fn(async () => []),
    },
    sessionAccessLog: {
      findMany: jest.fn(async () => [
        {
          startedAt: new Date("2026-11-01T10:00:00Z"),
          endedAt: new Date("2026-11-01T12:00:00Z"),
          endReason: "SIGN_OUT",
          ipAddress: "203.0.113.7",
          userAgent: "Firefox",
        },
      ]),
    },
    $queryRaw: jest.fn(async () => [{ ready: true }]),
    $transaction: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import { TERMS_VERSION } from "../../lib/compliance/purpose-codes";
import {
  GET as getConsent,
  POST as postConsent,
  DELETE as deleteConsent,
} from "../../app/api/user/privacy/consent/route";
import { GET as getExport } from "../../app/api/user/privacy/export/route";

const mockPrisma = prisma as unknown as {
  consentArtifact: {
    findMany: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
  notificationPreference: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    updateMany: jest.Mock;
  };
  cookiePreference: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    updateMany: jest.Mock;
  };
  user: { findUnique: jest.Mock };
  newsletterSubscriber: {
    upsert: jest.Mock;
    updateMany: jest.Mock;
    updateManyAndReturn: jest.Mock;
  };
  payment: { findMany: jest.Mock };
  supportCase: { findMany: jest.Mock };
  membership: { findMany: jest.Mock };
  dpdpGrievance: { findMany: jest.Mock };
  consumerInvoice: { findMany: jest.Mock };
  appointmentParticipant: { findMany: jest.Mock };
  collaborator: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

describe("Personal DPDP Consent & §11 Data Export Routes", () => {
  const originalSalt = process.env.SENTRY_IDENTITY_SALT;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENTRY_IDENTITY_SALT = "test-dpdp-salt-32-chars-minimum!";
    const session = {
      user: { id: "user_dpdp_1", email: "user@example.com", role: "CONSULTEE" },
    };
    mockGetSession.mockResolvedValue(session);
    mockRequireApiAuth.mockResolvedValue({ session, error: null });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(mockPrisma),
    );
  });

  afterAll(() => {
    process.env.SENTRY_IDENTITY_SALT = originalSalt;
  });

  describe("/api/user/privacy/consent", () => {
    it("returns 401 when unauthenticated", async () => {
      mockRequireApiAuth.mockResolvedValueOnce({
        session: null,
        error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      });
      const res = await getConsent();
      expect(res.status).toBe(401);
    });

    it("returns personal ConsentArtifact rows on GET", async () => {
      mockPrisma.consentArtifact.findMany.mockResolvedValueOnce([
        {
          id: "ca_1",
          dataFiduciary: "Familiarise",
          purposeCodes: ["ANALYTICS"],
        },
      ]);

      const res = await getConsent();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [expect.objectContaining({ id: "ca_1" })],
      });
    });

    it("subscribes the account's address to the newsletter in the MARKETING_COMMS grant's transaction, without a confirmation email", async () => {
      mockPrisma.consentArtifact.create.mockImplementationOnce(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: "ca_mkt_1",
          ...data,
        }),
      );

      const req = new NextRequest("http://localhost/api/user/privacy/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purposeCodes: ["MARKETING_COMMS"],
          language: "en-IN",
          version: 1,
        }),
      });

      const res = await postConsent(req);
      expect(res.status).toBe(201);
      expect(mockPrisma.consentArtifact.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user_dpdp_1",
            dataFiduciary: "Familiarise",
            purposeCodes: ["MARKETING_COMMS"],
            // The server stamps the current notice, whatever the client sends.
            version: TERMS_VERSION,
          }),
        }),
      );
      const fields = {
        userId: "user_dpdp_1",
        status: "SUBSCRIBED",
        confirmedAt: expect.any(Date),
        unsubscribedAt: null,
      };
      expect(mockPrisma.newsletterSubscriber.upsert).toHaveBeenCalledWith({
        where: { email: "user@example.com" },
        create: expect.objectContaining({
          email: "user@example.com",
          ...fields,
        }),
        update: expect.objectContaining(fields),
      });
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.cookiePreference.upsert).not.toHaveBeenCalled();
    });

    it("refuses to grant ANALYTICS, which is not offered, and writes nothing", async () => {
      const req = new NextRequest("http://localhost/api/user/privacy/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purposeCodes: ["ANALYTICS"] }),
      });

      const res = await postConsent(req);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("PURPOSE_NOT_OFFERED");
      expect(mockPrisma.consentArtifact.create).not.toHaveBeenCalled();
      expect(mockPrisma.newsletterSubscriber.upsert).not.toHaveBeenCalled();
    });

    it("blocks direct withdrawal of core platform purpose PRIMARY_PROCESSING with 400 CORE_CONSENT_REQUIRES_ACCOUNT_CLOSURE", async () => {
      const req = new NextRequest(
        "http://localhost/api/user/privacy/consent?purposeCode=PRIMARY_PROCESSING",
        { method: "DELETE" },
      );

      const res = await deleteConsent(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("CORE_CONSENT_REQUIRES_ACCOUNT_CLOSURE");
      expect(mockWithdrawConsent).not.toHaveBeenCalled();
    });

    it("withdraws MARKETING_COMMS and unsubscribes the account's newsletter rows in one transaction", async () => {
      mockWithdrawConsent.mockResolvedValueOnce({ withdrawnCount: 1 });

      const req = new NextRequest(
        "http://localhost/api/user/privacy/consent?purposeCode=MARKETING_COMMS",
        { method: "DELETE" },
      );

      const res = await deleteConsent(req);
      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockWithdrawConsent).toHaveBeenCalledWith(
        { userId: "user_dpdp_1", purposeCode: "MARKETING_COMMS" },
        mockPrisma,
      );
      expect(mockPrisma.newsletterSubscriber.updateMany).toHaveBeenCalledWith({
        where: {
          OR: [{ userId: "user_dpdp_1" }, { email: "user@example.com" }],
          status: { in: ["PENDING", "SUBSCRIBED"] },
        },
        data: { status: "UNSUBSCRIBED", unsubscribedAt: expect.any(Date) },
      });
      // Subscriber rows are locked before any consent artifact is written.
      expect(
        mockPrisma.newsletterSubscriber.updateManyAndReturn.mock
          .invocationCallOrder[0],
      ).toBeLessThan(mockWithdrawConsent.mock.invocationCallOrder[0]);
      // A sign-up made before the account existed holds a pseudonymous artifact.
      expect(mockPrisma.consentArtifact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            subjectPseudonymousId: expect.any(String),
          }),
        }),
      );
      expect(
        mockPrisma.notificationPreference.updateMany,
      ).not.toHaveBeenCalled();
      expect(mockPrisma.cookiePreference.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("/api/user/privacy/export", () => {
    it("returns a machine-readable JSON download with DPDP §11(1)(a) & §11(1)(b) fields", async () => {
      const now = new Date();
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "user_dpdp_1",
        name: "Aarav Sharma",
        email: "aarav@example.com",
        emailVerified: true,
        phone: "+919876543210",
        address: "Bengaluru",
        city: "Bengaluru",
        country: "IN",
        timezone: "Asia/Kolkata",
        dateOfBirth: new Date("1995-05-10"),
        gender: "MALE",
        bio: "Software Engineer",
        linkedinUrl: null,
        role: "CONSULTEE",
        onboardingCompleted: true,
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        razorpayCustomerId: null,
        consultantProfile: null,
        consulteeProfile: {
          id: "cp_1",
          aboutMe: "Learning distributed systems",
          preferredLanguage: "en",
          goals: "Crack system design",
          careerStage: "MID_LEVEL",
          skillsToDevelop: ["Architecture"],
          budgetPreference: null,
        },
        workExperiences: [],
        education: [],
        certifications: [],
        memberships: [],
        notificationPreferences: { marketingEmails: false },
        cookiePreferences: { analytics: false, marketing: false },
      });
      mockPrisma.consentArtifact.findMany.mockResolvedValueOnce([]);
      mockPrisma.dpdpGrievance.findMany.mockResolvedValueOnce([]);
      mockPrisma.payment.findMany.mockResolvedValueOnce([]);
      mockPrisma.consumerInvoice.findMany.mockResolvedValueOnce([
        {
          id: "inv_1",
          invoiceNumber: "INV-2026-001",
          totalPaise: BigInt(150000),
          currency: "INR",
          issuedAt: now,
        },
      ]);
      mockPrisma.supportCase.findMany.mockResolvedValueOnce([]);
      mockPrisma.membership.findMany.mockResolvedValueOnce([]);
      mockPrisma.appointmentParticipant.findMany.mockResolvedValueOnce([]);
      mockPrisma.collaborator.findMany.mockResolvedValueOnce([
        {
          id: "collab_1",
          role: "CO_HOST",
          status: "REMOVED",
          revenueShareBps: 2500,
          createdAt: new Date("2026-10-01T00:00:00Z"),
          acceptedAt: new Date("2026-10-02T00:00:00Z"),
          endedAt: new Date("2026-10-20T00:00:00Z"),
          webinarPlan: { title: "Design reviews" },
          classPlan: null,
        },
        // One row more than the export lists: the read's probe for a longer history.
        ...Array.from({ length: 200 }, (_, i) => ({
          id: `collab_older_${i}`,
          role: "MODERATOR",
          status: "EXPIRED",
          revenueShareBps: 1000,
          createdAt: new Date("2026-09-01T00:00:00Z"),
          acceptedAt: null,
          endedAt: new Date("2026-09-15T00:00:00Z"),
          webinarPlan: null,
          classPlan: { title: "Older class" },
        })),
      ]);

      const res = await getExport();
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toMatch(
        /^attachment; filename="familiarise-data-summary-user_dpd\.json"$/,
      );

      const payload = JSON.parse(await res.text());
      expect(payload.schemaVersion).toBe("dpdp-2023-s11-v1");
      expect(payload.personalDataSummary.profile.email).toBe(
        "aarav@example.com",
      );
      expect(
        payload.personalDataSummary.profile.pseudonymousTelemetryToken,
      ).toMatch(/^ust_[a-f0-9]{32}$/);
      expect(
        payload.personalDataSummary.activitySummary.consumerInvoices[0]
          .totalPaise,
      ).toBe(150000);
      expect(
        payload.personalDataSummary.activitySummary.sessionAccessLog,
      ).toEqual([
        {
          startedAt: "2026-11-01T10:00:00.000Z",
          endedAt: "2026-11-01T12:00:00.000Z",
          endReason: "SIGN_OUT",
          ipAddress: "203.0.113.7",
          userAgent: "Firefox",
        },
      ]);
      expect(
        payload.personalDataSummary.activitySummary.sessionAccessLogTruncated,
      ).toBe(false);
      // The user's own collaborations, ended ones included, and nobody else's:
      // the newest 200, with a flag when the history is longer.
      const { collaborations, collaborationsTruncated } =
        payload.personalDataSummary.activitySummary;
      expect(collaborations).toHaveLength(200);
      expect(collaborationsTruncated).toBe(true);
      expect(collaborations.slice(0, 1)).toEqual([
        {
          id: "collab_1",
          planType: "WEBINAR",
          planTitle: "Design reviews",
          role: "CO_HOST",
          status: "REMOVED",
          revenueSharePercent: 25,
          invitedAt: "2026-10-01T00:00:00.000Z",
          acceptedAt: "2026-10-02T00:00:00.000Z",
          endedAt: "2026-10-20T00:00:00.000Z",
        },
      ]);
      const collaborationRead =
        mockPrisma.collaborator.findMany.mock.calls[0][0];
      expect(collaborationRead.where).toEqual({
        consultantProfile: { userId: "user_dpdp_1" },
      });
      expect(collaborationRead.take).toBe(201);
      expect(collaborationRead.select).not.toHaveProperty("invitedById");
      expect(collaborationRead.select.webinarPlan.select).toEqual({
        title: true,
      });
      expect(payload.sharedWithDataProcessors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityName: "Functional Software, Inc. (Sentry — us.sentry.io)",
          }),
        ]),
      );
      expect(
        payload.statutoryRetentionAndRightsInfo.grievanceAndBoardAppeal,
      ).toContain("90 days");
      expect(payload.personalDataSummary.activitySummary).toMatchObject({
        supportTickets: [],
        supportGrievances: [],
        supportMessages: [],
        supportEvidenceRequests: [],
        supportAttachments: [],
        supportRatings: [],
        supportChatAccess: [],
        supportExportComplete: true,
      });
    });
  });
});
