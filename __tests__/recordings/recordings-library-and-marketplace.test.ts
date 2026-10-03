/**
 * @jest-environment node
 */

import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";

const mockGetSession = jest.fn();
const mockConsultantProfileFindUnique = jest.fn();
const mockRequireApiAuth = jest.fn();
const mockIsPrivileged = jest.fn();
const mockRecordingCount = jest.fn();
const mockRecordingFindMany = jest.fn();
const mockRecordingPurchaseFindFirst = jest.fn();
const mockRecordingPurchaseFindMany = jest.fn();
const mockConsulteeProfileFindUnique = jest.fn();
const mockConsultationFindMany = jest.fn();
const mockSubscriptionFindMany = jest.fn();
const mockWebinarFindMany = jest.fn();
const mockClassFindMany = jest.fn();
const mockTrialFindMany = jest.fn();
const mockGetPaidPlanIds = jest.fn();
const mockGetBestRecordingUrl = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
  isPrivileged: (...args: unknown[]) => mockIsPrivileged(...args),
  forbiddenResponse: (msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findUnique: (...args: unknown[]) =>
        mockConsultantProfileFindUnique(...args),
    },
    recording: {
      count: (...args: unknown[]) => mockRecordingCount(...args),
      findMany: (...args: unknown[]) => mockRecordingFindMany(...args),
    },
    recordingPurchase: {
      findFirst: (...args: unknown[]) =>
        mockRecordingPurchaseFindFirst(...args),
      findMany: (...args: unknown[]) => mockRecordingPurchaseFindMany(...args),
    },
    consulteeProfile: {
      findUnique: (...args: unknown[]) =>
        mockConsulteeProfileFindUnique(...args),
    },
    consultation: {
      findMany: (...args: unknown[]) => mockConsultationFindMany(...args),
    },
    subscription: {
      findMany: (...args: unknown[]) => mockSubscriptionFindMany(...args),
    },
    webinar: {
      findMany: (...args: unknown[]) => mockWebinarFindMany(...args),
    },
    class: {
      findMany: (...args: unknown[]) => mockClassFindMany(...args),
    },
    trial: {
      findMany: (...args: unknown[]) => mockTrialFindMany(...args),
    },
  },
}));

jest.mock("../../lib/stream/recording-service", () => ({
  __esModule: true,
  RecordingService: {
    getPaidPlanIds: (...args: unknown[]) => mockGetPaidPlanIds(...args),
  },
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  __esModule: true,
  getBestRecordingUrl: (...args: unknown[]) => mockGetBestRecordingUrl(...args),
}));

jest.mock("../../lib/stream/late-join-recordings", () => ({
  __esModule: true,
  lateJoinRecordingAccess: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock("../../lib/stream/session-recordings", () => ({
  __esModule: true,
  extractRecordings: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../lib/data/recordings-explore", () => ({
  __esModule: true,
  getPublicRecordingBySlug: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { GET as getConsultantRecordings } from "@/app/api/consultants/[consultantId]/recordings/route";
import { GET as getConsulteeResources } from "@/app/api/dashboard/consultee/[consulteeId]/resources/route";
import { canUserWatchRecording } from "@/app/explore/recordings/[slug]/page";
import { EVENT_TYPE_LABELS } from "@/components/dashboard/library/LibraryBrowser";
import type { RecordingListing } from "@/lib/data/recordings-explore";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("Recordings Library, Marketplace Unlock & Contextual Appointment Chat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBestRecordingUrl.mockResolvedValue(
      "https://signed.example.com/rec.mp4",
    );
    mockGetPaidPlanIds.mockResolvedValue({
      webinarPlanIds: [],
      classPlanIds: [],
    });
  });

  describe("GET /api/consultants/[consultantId]/recordings", () => {
    it("supports consultation and subscription type filters and returns marketplace listing fields", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: "u-consultant", role: "CONSULTANT" },
      });
      mockConsultantProfileFindUnique.mockResolvedValue({ id: "cp-1" });
      mockRecordingCount.mockResolvedValue(1);
      mockRecordingFindMany.mockResolvedValue([
        {
          id: "rec-1",
          title: "1:1 Consultation Session",
          durationInMinutes: 45,
          recordedAt: new Date("2026-10-01T10:00:00Z"),
          status: "AVAILABLE",
          storageType: "PLATFORM",
          storagePath: "recordings/rec-1.mp4",
          recordingUrl: "https://stream.io/rec-1.mp4",
          thumbnailUrl: null,
          resolution: "1080p",
          fileSize: 52428800,
          streamUrlExpiresAt: null,
          transferredAt: new Date("2026-10-01T11:00:00Z"),
          listingStatus: "PUBLISHED",
          listPricePaise: 49900,
          listingTitle: "Masterclass Replay",
          listingDescription: "Full session recording",
          slug: "masterclass-replay",
          tags: ["system-design", "architecture"],
          previewClipUrl: "https://cdn.example.com/preview.mp4",
          previewTranscript: "Welcome to the session.",
          consentAttestedAt: new Date("2026-10-01T12:00:00Z"),
          createdAt: new Date("2026-10-01T10:00:00Z"),
          meeting: {
            occurrence: {
              startsAt: new Date("2026-10-01T10:00:00Z"),
              appointment: {
                participants: [],
                webinar: null,
                class: null,
                consultation: {
                  consultationPlan: {
                    id: "cplan-1",
                    title: "Architecture Consultation",
                  },
                },
                subscription: null,
                trial: null,
              },
            },
          },
        },
      ]);

      const req = new NextRequest(
        "http://localhost:3000/api/consultants/cp-1/recordings?type=consultation&page=1&limit=12",
      );
      const res = await getConsultantRecordings(req, {
        params: Promise.resolve({ consultantId: "cp-1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recordings).toHaveLength(1);
      expect(body.recordings[0]).toMatchObject({
        id: "rec-1",
        planType: "consultation",
        planId: "cplan-1",
        planTitle: "Architecture Consultation",
        listingStatus: "PUBLISHED",
        listPricePaise: 49900,
        listingTitle: "Masterclass Replay",
        slug: "masterclass-replay",
        tags: ["system-design", "architecture"],
        previewClipUrl: "https://cdn.example.com/preview.mp4",
        previewTranscript: "Welcome to the session.",
      });
    });
  });

  describe("GET /api/dashboard/consultee/[consulteeId]/resources", () => {
    it("includes SUCCEEDED RecordingPurchase items under data.purchased", async () => {
      mockRequireApiAuth.mockResolvedValue({
        session: {
          user: {
            id: "u-buyer",
            role: "CONSULTEE",
            consulteeProfileId: "ce-1",
          },
        },
      });
      mockIsPrivileged.mockReturnValue(false);
      mockConsulteeProfileFindUnique.mockResolvedValue({ userId: "u-buyer" });
      mockConsultationFindMany.mockResolvedValue([]);
      mockSubscriptionFindMany.mockResolvedValue([]);
      mockWebinarFindMany.mockResolvedValue([]);
      mockClassFindMany.mockResolvedValue([]);
      mockTrialFindMany.mockResolvedValue([]);
      mockRecordingPurchaseFindMany.mockResolvedValue([
        {
          id: "pur-1",
          recordingId: "rec-99",
          buyerId: "u-buyer",
          status: "SUCCEEDED",
          recording: {
            id: "rec-99",
            title: "Raw Webinar Recording",
            listingTitle: "Distributed Systems Deep Dive",
            durationInMinutes: 90,
            recordedAt: new Date("2026-09-25T15:00:00Z"),
            status: "AVAILABLE",
            storagePath: "recordings/rec-99.mp4",
            recordingUrl: null,
            thumbnailUrl: "https://cdn.example.com/thumb.jpg",
            meeting: {
              occurrence: {
                appointment: {
                  webinar: {
                    webinarPlan: {
                      title: "Distributed Systems",
                      consultantProfile: {
                        user: {
                          id: "u-host",
                          name: "Dr. Meera",
                          image: null,
                        },
                      },
                    },
                  },
                  class: null,
                },
              },
            },
          },
        },
      ]);

      const req = new Request(
        "http://localhost:3000/api/dashboard/consultee/ce-1/resources",
      );
      const res = await getConsulteeResources(req, {
        params: Promise.resolve({ consulteeId: "ce-1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.purchased).toHaveLength(1);
      expect(body.data.purchased[0]).toMatchObject({
        id: "purchased-pur-1",
        planTitle: "Distributed Systems Deep Dive",
        consultantName: "Dr. Meera",
        eventType: "purchased",
        status: "COMPLETED",
      });
      expect(body.data.purchased[0].recordings[0].playbackUrl).toBe(
        "https://signed.example.com/rec.mp4",
      );
    });
  });

  describe("canUserWatchRecording (app/explore/recordings/[slug]/page.tsx)", () => {
    const sampleListing: RecordingListing = {
      id: "rec-100",
      slug: "system-design-live",
      listingTitle: "System Design Live",
      listingDescription: "Replay",
      listPricePaise: 99900,
      tags: ["design"],
      thumbnailUrl: null,
      previewClipUrl: "https://cdn.example.com/clip.mp4",
      previewTranscript: "Transcript",
      previewClipDuration: 60,
      durationInMinutes: 60,
      recordedAt: new Date("2026-09-01T10:00:00Z"),
      publishedAt: new Date("2026-09-02T10:00:00Z"),
      planType: "WEBINAR",
      planId: "wplan-1",
      planTitle: "System Design",
      consultant: {
        profileId: "cp-owner",
        name: "Host",
        image: null,
        headline: "Architect",
      },
    };

    it("grants access to owning consultant, SUCCEEDED replay buyer, and paid plan enrollee", async () => {
      // 1. Owning consultant
      expect(
        await canUserWatchRecording("u-owner", "cp-owner", sampleListing),
      ).toBe(true);

      // 2. Replay buyer
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce({ id: "pur-1" });
      expect(await canUserWatchRecording("u-buyer", null, sampleListing)).toBe(
        true,
      );

      // 3. Paid parent webinar plan holder
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce(null);
      mockGetPaidPlanIds.mockResolvedValueOnce({
        webinarPlanIds: ["wplan-1"],
        classPlanIds: [],
      });
      expect(
        await canUserWatchRecording("u-attendee", null, sampleListing),
      ).toBe(true);

      // 4. Unentitled user
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce(null);
      mockGetPaidPlanIds.mockResolvedValueOnce({
        webinarPlanIds: [],
        classPlanIds: [],
      });
      expect(
        await canUserWatchRecording("u-stranger", null, sampleListing),
      ).toBe(false);
    });
  });

  describe("LibraryBrowser EVENT_TYPE_LABELS & Appointment Chat Policy", () => {
    it("maps consultation and subscription in EVENT_TYPE_LABELS", () => {
      expect(EVENT_TYPE_LABELS.consultation).toBe("Consultation");
      expect(EVENT_TYPE_LABELS.subscription).toBe("Subscription");
    });

    it("wires contextual Message Consultee / Message Consultant / Open Event Chat and trial chat guard", () => {
      const consultantAdapter = read(
        "app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter.tsx",
      );
      expect(consultantAdapter).toContain("Message Consultee");
      expect(consultantAdapter).toContain("Open Event Chat");
      expect(consultantAdapter).toContain("contextAppointmentId=");

      const consulteeAdapter = read(
        "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
      );
      expect(consulteeAdapter).toContain("Message Consultant");
      expect(consulteeAdapter).toContain("Open Event Chat");
      expect(consulteeAdapter).toContain("contextAppointmentId=");

      const sheet = read("components/appointments/AppointmentSheet.tsx");
      expect(sheet).toContain("Chat unavailable for trials");

      const detail = read(
        "components/appointments/detail/AppointmentDetailClient.tsx",
      );
      expect(detail).toContain("Chat unavailable for trials");
      expect(detail).toContain("RecordingPlayerModal");
    });
  });
});
