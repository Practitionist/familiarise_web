/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetSession = jest.fn();
const mockRequireApiAuth = jest.fn();
const mockRequireOrgAccess = jest.fn();
const mockGetBestRecordingUrl = jest.fn();
const mockService = {
  getPaidPlanIds: jest.fn(),
  getConsulteeRecordings: jest.fn(),
  getWebinarPlanRecordings: jest.fn(),
  getClassPlanRecordings: jest.fn(),
};
const mockDb = {
  consulteeProfile: { findUnique: jest.fn() },
  consultation: { findMany: jest.fn() },
  subscription: { findMany: jest.fn() },
  webinar: { findMany: jest.fn() },
  class: { findMany: jest.fn() },
  trial: { findMany: jest.fn() },
  recordingPurchase: { findMany: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  classPlan: { findUnique: jest.fn() },
  appointment: { count: jest.fn(), findMany: jest.fn() },
  $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
  requireOrgAccess: (...args: unknown[]) => mockRequireOrgAccess(...args),
  forbiddenResponse: (msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
  isPrivileged: (role: string) => role === "ADMIN",
}));
jest.mock("../../lib/stream/recording-service", () => ({
  get RecordingService() {
    return mockService;
  },
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  getBestRecordingUrl: (...args: unknown[]) => mockGetBestRecordingUrl(...args),
}));
jest.mock("../../lib/stream/late-join-recordings", () => ({
  ...jest.requireActual("../../lib/stream/late-join-recordings"),
  lateJoinRecordingAccess: async () => ({
    floors: new Map(),
    lateSeatBatches: new Map(),
  }),
}));

import { GET as getConsulteeResources } from "@/app/api/dashboard/consultee/[consulteeId]/resources/route";
import { GET as getConsulteeRecordings } from "@/app/api/consultees/[consulteeId]/recordings/route";
import { GET as getOrgRecordings } from "@/app/api/organizations/[orgId]/recordings/route";
import { GET as getWebinarPlanRecordings } from "@/app/api/plans/webinars/[webinarPlanId]/recordings/route";
import { GET as getClassPlanRecordings } from "@/app/api/plans/classes/[classPlanId]/recordings/route";

const recordedAt = new Date("2026-10-01T10:00:00Z");
const session = {
  occurrence: {
    startsAt: recordedAt,
    appointment: {
      id: "apt-1",
      classId: null,
      class: null,
      webinar: { webinarPlan: { id: "wp-1", title: "Webinar" } },
    },
  },
};
/** A full DB row: every field a list could leak media through is populated. */
const row = (id: string) => ({
  id,
  title: `Recording ${id}`,
  durationInMinutes: 30,
  recordedAt,
  status: "AVAILABLE",
  storageType: "PLATFORM",
  storagePath: `recordings/${id}.mp4`,
  recordingUrl: `https://ohio.stream-io-cdn.com/${id}.mp4`,
  thumbnailUrl: null,
  resolution: "1080p",
  previewClipUrl: null,
  previewClipDuration: null,
  streamUrlExpiresAt: null,
  createdAt: recordedAt,
  meeting: session,
});
const withRecordings = (id: string) => ({
  occurrences: [{ startsAt: recordedAt, meeting: { recordings: [row(id)] } }],
});

function expectNoPlaybackMedia(body: unknown, recordingId: string): void {
  const json = JSON.stringify(body);
  expect(json).toContain(recordingId);
  for (const banned of [
    "playbackUrl",
    "recordingUrl",
    "storagePath",
    "stream-io-cdn",
    "r2.cloudflarestorage.com",
  ]) {
    expect(json).not.toContain(banned);
  }
  expect(mockGetBestRecordingUrl).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBestRecordingUrl.mockReturnValue(
    "https://acct.r2.cloudflarestorage.com/recordings/x.mp4",
  );
  mockGetSession.mockResolvedValue({
    user: { id: "u-1", role: "ADMIN", consulteeProfileId: "ce-1" },
  });
});

describe("recording list payloads carry no playback media", () => {
  it("GET /api/dashboard/consultee/[consulteeId]/resources", async () => {
    mockRequireApiAuth.mockResolvedValue({
      session: {
        user: { id: "u-1", role: "CONSULTEE", consulteeProfileId: "ce-1" },
      },
    });
    mockDb.consulteeProfile.findUnique.mockResolvedValue({ userId: "u-1" });
    mockService.getPaidPlanIds.mockResolvedValue({
      webinarScope: { sharedPlanIds: [], appointmentIds: [] },
      classPlanIds: [],
    });
    const plan = {
      title: "Plan",
      materials: [],
      consultantProfile: { user: { id: "u-x", name: "Expert", image: null } },
    };
    mockDb.consultation.findMany.mockResolvedValue([
      {
        id: "c-1",
        status: "COMPLETED",
        requestedAt: recordedAt,
        consultationPlan: plan,
        appointment: withRecordings("rec-own"),
      },
    ]);
    mockDb.subscription.findMany.mockResolvedValue([]);
    mockDb.webinar.findMany.mockResolvedValue([]);
    mockDb.class.findMany.mockResolvedValue([]);
    mockDb.trial.findMany.mockResolvedValue([]);
    mockDb.recordingPurchase.findMany.mockResolvedValue([
      { id: "pur-1", recording: { ...row("rec-bought"), listingTitle: null } },
    ]);

    const res = await getConsulteeResources(
      new Request("http://localhost/api/dashboard/consultee/ce-1/resources"),
      { params: Promise.resolve({ consulteeId: "ce-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expectNoPlaybackMedia(body, "rec-own");
    expect(JSON.stringify(body)).toContain("rec-bought");
  });

  it("GET /api/consultees/[consulteeId]/recordings", async () => {
    mockService.getConsulteeRecordings.mockResolvedValue([row("rec-1")]);

    const res = await getConsulteeRecordings(
      new NextRequest("http://localhost/api/consultees/ce-1/recordings"),
      { params: Promise.resolve({ consulteeId: "ce-1" }) },
    );

    expect(res.status).toBe(200);
    expectNoPlaybackMedia(await res.json(), "rec-1");
  });

  it("GET /api/organizations/[orgId]/recordings (Mine)", async () => {
    mockRequireOrgAccess.mockResolvedValue({
      member: { role: "OWNER", status: "ACTIVE" },
      session: { user: { id: "u-1" } },
    });
    mockDb.appointment.count.mockResolvedValue(1);
    mockDb.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        appointmentType: "CONSULTATION",
        consultation: { consultationPlan: { title: "Plan" } },
        class: null,
        ...withRecordings("rec-org"),
      },
    ]);

    const res = await getOrgRecordings(
      new NextRequest("http://localhost/api/organizations/org-1/recordings"),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expectNoPlaybackMedia(body, "rec-org");
    expect(body.groups[0].files[0].playable).toBe(true);
  });

  it("GET /api/plans/webinars/[webinarPlanId]/recordings", async () => {
    mockDb.webinarPlan.findUnique.mockResolvedValue({
      id: "wp-1",
      title: "Webinar",
      consultantProfileId: "cp-1",
      recordingEnabled: true,
    });
    mockService.getWebinarPlanRecordings.mockResolvedValue([row("rec-w")]);

    const res = await getWebinarPlanRecordings(
      new NextRequest("http://localhost/api/plans/webinars/wp-1/recordings"),
      { params: Promise.resolve({ webinarPlanId: "wp-1" }) },
    );

    expect(res.status).toBe(200);
    expectNoPlaybackMedia(await res.json(), "rec-w");
  });

  it("GET /api/plans/classes/[classPlanId]/recordings", async () => {
    mockDb.classPlan.findUnique.mockResolvedValue({
      id: "cp-1",
      title: "Class",
      consultantProfileId: "cp-1",
      recordingEnabled: true,
    });
    mockService.getClassPlanRecordings.mockResolvedValue([row("rec-c")]);

    const res = await getClassPlanRecordings(
      new NextRequest("http://localhost/api/plans/classes/cp-1/recordings"),
      { params: Promise.resolve({ classPlanId: "cp-1" }) },
    );

    expect(res.status).toBe(200);
    expectNoPlaybackMedia(await res.json(), "rec-c");
  });
});
