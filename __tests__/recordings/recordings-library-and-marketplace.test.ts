/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetSession = jest.fn();
const mockConsultantProfileFindUnique = jest.fn();
const mockRequireApiAuth = jest.fn();
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
const mockRecordingFindUnique = jest.fn();
const mockGetPublicRecordingBySlug = jest.fn();
const mockLateJoinRecordingAccess = jest.fn();
const mockAuditOperatorRecordingAccess = jest.fn();

jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  useSession: jest.fn(),
  getSession: jest.fn(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
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
      findUnique: (...args: unknown[]) => mockRecordingFindUnique(...args),
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

jest.mock("../../lib/stream/recording-storage", () => {
  const actual = jest.requireActual("../../lib/stream/recording-storage");
  return {
    __esModule: true,
    ...actual,
    getBestRecordingUrl: (...args: unknown[]) =>
      mockGetBestRecordingUrl(...args),
  };
});

jest.mock("../../lib/stream/late-join-recordings", () => {
  const actual = jest.requireActual("../../lib/stream/late-join-recordings");
  return {
    __esModule: true,
    ...actual,
    lateJoinRecordingAccess: (...args: unknown[]) =>
      mockLateJoinRecordingAccess(...args),
  };
});

jest.mock("../../lib/stream/recording-operator-access", () => {
  const actual = jest.requireActual(
    "../../lib/stream/recording-operator-access",
  );
  return {
    __esModule: true,
    ...actual,
    auditOperatorRecordingAccess: (...args: unknown[]) =>
      mockAuditOperatorRecordingAccess(...args),
  };
});

jest.mock("../../lib/stream/session-recordings", () => ({
  __esModule: true,
  extractRecordings: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../lib/data/recordings-explore", () => ({
  __esModule: true,
  getPublicRecordingBySlug: (...args: unknown[]) =>
    mockGetPublicRecordingBySlug(...args),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { GET as getConsultantRecordings } from "@/app/api/consultants/[consultantId]/recordings/route";
import { GET as getConsulteeResources } from "@/app/api/dashboard/consultee/[consulteeId]/resources/route";
import RecordingDetailPage from "@/app/explore/recordings/[slug]/page";
import { chatAffordancesForVm } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { EVENT_TYPE_LABELS } from "@/components/dashboard/library/LibraryBrowser";
import {
  ClientPublishSchema,
  canDeleteRecording,
} from "@/components/recordings/RecordingManageSheet";
import { resolveActivePlaybackUrl } from "@/components/recordings/RecordingPlayerModal";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type { RecordingListing } from "@/lib/data/recordings-explore";

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
    mockLateJoinRecordingAccess.mockResolvedValue({
      floors: new Map(),
      lateSeatBatches: new Map(),
    });
    mockAuditOperatorRecordingAccess.mockResolvedValue(undefined);
  });

  describe("GET /api/consultants/[consultantId]/recordings", () => {
    it("supports consultation and subscription type filters and returns capability and buyer flags without eager playback URL signing", async () => {
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
          listingStatus: "UNPUBLISHED",
          listPricePaise: 49900,
          listingTitle: "Masterclass Replay",
          listingDescription: "Full session recording",
          slug: "masterclass-replay",
          tags: ["system-design", "architecture"],
          previewClipUrl: "https://cdn.example.com/preview.mp4",
          previewTranscript: "Welcome to the session.",
          consentAttestedAt: new Date("2026-10-01T12:00:00Z"),
          createdAt: new Date("2026-10-01T10:00:00Z"),
          purchases: [{ id: "pur-buyer-1" }],
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
                    consultantProfileId: "cp-1",
                    recordingStoragePolicy: "STREAM_ONLY",
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
        playbackUrl: null,
        listingStatus: "UNPUBLISHED",
        listPricePaise: 49900,
        listingTitle: "Masterclass Replay",
        slug: "masterclass-replay",
        tags: ["system-design", "architecture"],
        previewClipUrl: "https://cdn.example.com/preview.mp4",
        previewTranscript: "Welcome to the session.",
        hasBuyers: true,
        canManage: true,
        canTransfer: false,
        canPublish: false,
      });
      expect(mockGetBestRecordingUrl).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/dashboard/consultee/[consulteeId]/resources", () => {
    it("includes SUCCEEDED RecordingPurchase items under data.purchased with READY/AVAILABLE filter and take: 50 without eager URL signing", async () => {
      mockRequireApiAuth.mockResolvedValue({
        session: {
          user: {
            id: "u-buyer",
            role: "CONSULTEE",
            consulteeProfileId: "ce-1",
          },
        },
      });
      mockConsulteeProfileFindUnique.mockResolvedValue({ userId: "u-buyer" });
      mockConsultationFindMany.mockResolvedValue([]);
      mockSubscriptionFindMany.mockResolvedValue([]);
      mockWebinarFindMany.mockResolvedValue([]);
      mockClassFindMany.mockResolvedValue([]);
      mockTrialFindMany.mockResolvedValue([]);
      const purchaseItem = {
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
      };
      mockRecordingPurchaseFindMany.mockResolvedValue([
        purchaseItem,
        { ...purchaseItem, id: "pur-dup" },
      ]);

      const req = new Request(
        "http://localhost:3000/api/dashboard/consultee/ce-1/resources",
      );
      const res = await getConsulteeResources(req, {
        params: Promise.resolve({ consulteeId: "ce-1" }),
      });

      expect(res.status).toBe(200);
      expect(mockRecordingPurchaseFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            buyerId: "u-buyer",
            status: "SUCCEEDED",
            recording: {
              status: { in: ["READY", "AVAILABLE"] },
            },
          },
          take: 50,
        }),
      );
      const body = await res.json();
      expect(body.data.purchased).toHaveLength(1);
      expect(body.data.purchased[0]).toMatchObject({
        id: "purchased-pur-1",
        planTitle: "Distributed Systems Deep Dive",
        consultantName: "Dr. Meera",
        eventType: "purchased",
        status: "COMPLETED",
      });
      expect(body.data.purchased[0].recordings[0].playbackUrl).toBeNull();
      expect(mockGetBestRecordingUrl).not.toHaveBeenCalled();
    });

    it("redacts thumbnailUrl and audits metadata-only access for STAFF operators", async () => {
      mockRequireApiAuth.mockResolvedValue({
        session: {
          user: {
            id: "u-staff",
            role: "STAFF",
            consulteeProfileId: null,
          },
        },
      });
      mockConsulteeProfileFindUnique.mockResolvedValue({ userId: "u-buyer" });
      mockConsultationFindMany.mockResolvedValue([]);
      mockSubscriptionFindMany.mockResolvedValue([]);
      mockWebinarFindMany.mockResolvedValue([]);
      mockClassFindMany.mockResolvedValue([]);
      mockTrialFindMany.mockResolvedValue([]);
      mockRecordingPurchaseFindMany.mockResolvedValue([
        {
          id: "pur-staff",
          recordingId: "rec-staff-1",
          buyerId: "u-buyer",
          status: "SUCCEEDED",
          recording: {
            id: "rec-staff-1",
            title: "Webinar Recording",
            listingTitle: "Staff Audited Replay",
            durationInMinutes: 60,
            recordedAt: new Date("2026-09-25T15:00:00Z"),
            status: "AVAILABLE",
            storagePath: "recordings/rec-staff-1.mp4",
            recordingUrl: null,
            thumbnailUrl: "https://cdn.example.com/thumb.jpg",
            meeting: {
              occurrence: {
                appointment: {
                  webinar: null,
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
      expect(body.data.purchased[0].recordings[0].thumbnailUrl).toBeNull();
      expect(mockAuditOperatorRecordingAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: "u-staff",
          actorRole: "STAFF",
          played: false,
        }),
      );
    });
  });

  describe("RecordingDetailPage (app/explore/recordings/[slug]/page.tsx)", () => {
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

    it("grants unlocked playback to owning consultant, SUCCEEDED replay buyer, and paid plan enrollee while gating strangers and late joiners", async () => {
      mockGetPublicRecordingBySlug.mockResolvedValue(sampleListing);
      mockRecordingFindUnique.mockResolvedValue({
        status: "AVAILABLE",
        storagePath: "recordings/rec-100.mp4",
        recordingUrl: null,
        meeting: {
          occurrence: {
            startsAt: new Date("2026-09-01T10:00:00Z"),
            appointment: {
              classId: null,
              class: null,
            },
          },
        },
      });

      // 1. Owning consultant
      mockGetSession.mockResolvedValueOnce({
        user: { id: "u-owner", consultantProfileId: "cp-owner" },
      });
      await RecordingDetailPage({
        params: Promise.resolve({ slug: "system-design-live" }),
      });
      expect(mockGetBestRecordingUrl).toHaveBeenCalledTimes(1);

      // 2. Replay buyer
      mockGetBestRecordingUrl.mockClear();
      mockGetSession.mockResolvedValueOnce({
        user: { id: "u-buyer", consultantProfileId: null },
      });
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce({ id: "pur-1" });
      await RecordingDetailPage({
        params: Promise.resolve({ slug: "system-design-live" }),
      });
      expect(mockGetBestRecordingUrl).toHaveBeenCalledTimes(1);

      // 3. Paid parent webinar plan holder
      mockGetBestRecordingUrl.mockClear();
      mockGetSession.mockResolvedValueOnce({
        user: { id: "u-attendee", consultantProfileId: null },
      });
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce(null);
      mockGetPaidPlanIds.mockResolvedValueOnce({
        webinarPlanIds: ["wplan-1"],
        classPlanIds: [],
      });
      await RecordingDetailPage({
        params: Promise.resolve({ slug: "system-design-live" }),
      });
      expect(mockGetBestRecordingUrl).toHaveBeenCalledTimes(1);

      // 4. Class late joiner whose floor is AFTER the session startsAt is denied free unlock
      mockGetBestRecordingUrl.mockClear();
      mockGetPublicRecordingBySlug.mockResolvedValueOnce({
        ...sampleListing,
        planType: "CLASS",
        planId: "cplan-late",
      });
      mockRecordingFindUnique.mockResolvedValueOnce({
        status: "AVAILABLE",
        storagePath: "recordings/rec-100.mp4",
        recordingUrl: null,
        meeting: {
          occurrence: {
            startsAt: new Date("2026-09-01T10:00:00Z"),
            appointment: {
              classId: "class-late-1",
              class: { classPlanId: "cplan-late" },
            },
          },
        },
      });
      mockGetSession.mockResolvedValueOnce({
        user: { id: "u-late-joiner", consultantProfileId: null },
      });
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce(null);
      mockGetPaidPlanIds.mockResolvedValueOnce({
        webinarPlanIds: [],
        classPlanIds: ["cplan-late"],
      });
      mockLateJoinRecordingAccess.mockResolvedValueOnce({
        floors: new Map([["class-late-1", new Date("2026-09-05T00:00:00Z")]]),
        lateSeatBatches: new Map(),
      });
      await RecordingDetailPage({
        params: Promise.resolve({ slug: "system-design-live" }),
      });
      expect(mockGetBestRecordingUrl).not.toHaveBeenCalled();

      // 5. Unentitled user
      mockGetBestRecordingUrl.mockClear();
      mockGetSession.mockResolvedValueOnce({
        user: { id: "u-stranger", consultantProfileId: null },
      });
      mockRecordingPurchaseFindFirst.mockResolvedValueOnce(null);
      mockGetPaidPlanIds.mockResolvedValueOnce({
        webinarPlanIds: [],
        classPlanIds: [],
      });
      await RecordingDetailPage({
        params: Promise.resolve({ slug: "system-design-live" }),
      });
      expect(mockGetBestRecordingUrl).not.toHaveBeenCalled();
    });
  });

  describe("Delete guard, Player race guard & Contextual Appointment Chat", () => {
    it("maps consultation and subscription in EVENT_TYPE_LABELS", () => {
      expect(EVENT_TYPE_LABELS.consultation).toBe("Consultation");
      expect(EVENT_TYPE_LABELS.subscription).toBe("Subscription");
    });

    it("refuses deletion when a recording has buyers (including after unpublish) or when caller is not primary owner", () => {
      expect(canDeleteRecording({ canManage: true, hasBuyers: false })).toBe(
        true,
      );
      expect(canDeleteRecording({ canManage: true, hasBuyers: true })).toBe(
        false,
      );
      expect(canDeleteRecording({ canManage: false, hasBuyers: false })).toBe(
        false,
      );

      // ClientPublishSchema enforces server-matching slug, tag count, and price bounds
      expect(
        ClientPublishSchema.safeParse({
          listingTitle: "Valid Replay Title",
          listPricePaise: 49900,
          slug: "INVALID SLUG!",
          consentAttested: true,
        }).success,
      ).toBe(false);
    });

    it("ignores a stale presigned URL response for recording A after switching to recording B", () => {
      const recordingB = { id: "rec-B", playbackUrl: null };
      const lateResponseFromA = {
        recordingId: "rec-A",
        url: "https://signed.example.com/rec-A.mp4",
      };
      expect(
        resolveActivePlaybackUrl(recordingB, lateResponseFromA),
      ).toBeNull();

      const matchingResponseForB = {
        recordingId: "rec-B",
        url: "https://signed.example.com/rec-B.mp4",
      };
      expect(resolveActivePlaybackUrl(recordingB, matchingResponseForB)).toBe(
        "https://signed.example.com/rec-B.mp4",
      );
    });

    it("builds contextual DM and Event Chat affordances across DM_ELIGIBLE_STATUSES and OPENABLE_EVENT_STATUSES while requiring counterpartyUserId and excluding trials", () => {
      const baseConsultationVm = {
        id: "vm-1",
        appointmentId: "apt-1",
        kind: "CONSULTATION",
        status: "APPROVED",
        raw: {
          appointment: {
            consultation: {
              requestedBy: { user: { id: "u-consultee-1" } },
              consultationPlan: {
                consultantProfile: { user: { id: "u-consultant-1" } },
              },
            },
          },
        },
      } as unknown as AppointmentVM;

      // APPROVED is in DM_ELIGIBLE_STATUSES for both consultee and consultant
      const consulteeDmItems = chatAffordancesForVm({
        vm: baseConsultationVm,
        messagesBasePath: "/dashboard/consultee/ce-1/messages",
        role: "consultee",
        push: jest.fn(),
      });
      expect(consulteeDmItems).toEqual([
        expect.objectContaining({
          key: "message",
          label: "Message Consultant",
          href: "/dashboard/consultee/ce-1/messages?contextAppointmentId=apt-1&counterpartyUserId=u-consultant-1",
        }),
      ]);

      const consultantDmItems = chatAffordancesForVm({
        vm: baseConsultationVm,
        messagesBasePath: "/dashboard/consultant/cp-1/messages",
        role: "consultant",
        push: jest.fn(),
      });
      expect(consultantDmItems).toEqual([
        expect.objectContaining({
          key: "message",
          label: "Message Consultee",
          href: "/dashboard/consultant/cp-1/messages?contextAppointmentId=apt-1&counterpartyUserId=u-consultee-1",
        }),
      ]);

      // Missing counterpartyUserId omits the DM link instead of emitting a broken link
      const missingCounterpartyVm = {
        ...baseConsultationVm,
        raw: { appointment: {} },
      } as unknown as AppointmentVM;
      expect(
        chatAffordancesForVm({
          vm: missingCounterpartyVm,
          messagesBasePath: "/dashboard/consultee/ce-1/messages",
          role: "consultee",
          push: jest.fn(),
        }),
      ).toEqual([]);

      // Group webinar in SCHEDULED status offers Open Event Chat + Message Consultant when host userId is resolved
      const webinarVm = {
        id: "vm-web-1",
        appointmentId: "apt-web-1",
        kind: "WEBINAR",
        status: "SCHEDULED",
        raw: {
          appointment: {
            webinarId: "web-1",
            webinar: {
              id: "web-1",
              webinarPlan: {
                consultantProfile: { user: { id: "u-host-1" } },
              },
            },
          },
        },
      } as unknown as AppointmentVM;
      const webinarItems = chatAffordancesForVm({
        vm: webinarVm,
        messagesBasePath: "/dashboard/consultee/ce-1/messages",
        role: "consultee",
        push: jest.fn(),
      });
      expect(webinarItems.map((i) => i.label)).toEqual([
        "Open Event Chat",
        "Message Consultant",
      ]);

      // Trial bookings never emit direct chat or event chat items
      const trialVm = {
        ...baseConsultationVm,
        kind: "TRIAL",
        status: "SCHEDULED",
      } as unknown as AppointmentVM;
      expect(
        chatAffordancesForVm({
          vm: trialVm,
          messagesBasePath: "/dashboard/consultee/ce-1/messages",
          role: "consultee",
          push: jest.fn(),
        }),
      ).toEqual([]);
    });
  });
});
