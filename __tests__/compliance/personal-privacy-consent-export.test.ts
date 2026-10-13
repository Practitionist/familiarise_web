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
    },
    payment: {
      findMany: jest.fn(),
    },
    supportTicket: {
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
    $transaction: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import {
  GET as getConsent,
  POST as postConsent,
  DELETE as deleteConsent,
} from "../../app/api/user/privacy/consent/route";
import { GET as getExport } from "../../app/api/user/privacy/export/route";

const mockPrisma = prisma as unknown as {
  consentArtifact: { findMany: jest.Mock; create: jest.Mock };
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
  payment: { findMany: jest.Mock };
  supportTicket: { findMany: jest.Mock };
  dpdpGrievance: { findMany: jest.Mock };
  consumerInvoice: { findMany: jest.Mock };
  appointmentParticipant: { findMany: jest.Mock };
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
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => unknown) => fn(mockPrisma),
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

    it("returns personal ConsentArtifact rows and preference flags on GET", async () => {
      const now = new Date();
      mockPrisma.consentArtifact.findMany.mockResolvedValueOnce([
        {
          id: "ca_1",
          dataFiduciary: "Familiarise",
          purposeCodes: [
            "PRIMARY_PROCESSING",
            "SESSION_BOOKING",
            "STREAM_DATA_PROCESSING",
          ],
          language: "en-IN",
          version: 1,
          grantedAt: now,
          withdrawnAt: null,
          auditRetainedUntil: new Date(now.getTime() + 86400_000),
        },
      ]);
      mockPrisma.notificationPreference.findUnique.mockResolvedValueOnce({
        marketingEmails: true,
      });
      mockPrisma.cookiePreference.findUnique.mockResolvedValueOnce({
        analytics: false,
        marketing: true,
      });

      const res = await getConsent();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.preferences).toEqual({
        marketingEmails: true,
        cookieAnalytics: false,
        cookieMarketing: true,
      });
    });

    it("records optional MARKETING_COMMS consent and syncs NotificationPreference + CookiePreference on POST", async () => {
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
          }),
        }),
      );
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalled();
      expect(mockPrisma.cookiePreference.upsert).toHaveBeenCalled();
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

    it("withdraws optional MARKETING_COMMS in 1 click and disables marketing preferences", async () => {
      mockWithdrawConsent.mockResolvedValueOnce({ withdrawnCount: 1 });

      const req = new NextRequest(
        "http://localhost/api/user/privacy/consent?purposeCode=MARKETING_COMMS",
        { method: "DELETE" },
      );

      const res = await deleteConsent(req);
      expect(res.status).toBe(200);
      expect(mockWithdrawConsent).toHaveBeenCalledWith({
        userId: "user_dpdp_1",
        purposeCode: "MARKETING_COMMS",
      });
      expect(mockPrisma.notificationPreference.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user_dpdp_1" },
          data: { marketingEmails: false },
        }),
      );
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
      mockPrisma.supportTicket.findMany.mockResolvedValueOnce([]);
      mockPrisma.appointmentParticipant.findMany.mockResolvedValueOnce([]);

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
    });
  });
});
