/**
 * @jest-environment node
 */

/**
 * Booking routes: every `consultantProfile` relation they read is a shared
 * projection, never a bare `true` or an `include`, so the response cannot carry
 * the sensitive profile columns.
 */

import { NextRequest } from "next/server";
import {
  expectNoBareProfile,
  hasKey,
  readSource,
} from "../fixtures/consultant-projection";
import {
  HOST_PROFILE_SELECT,
  PARTY_PROFILE_SELECT,
  PARTY_USER_SELECT,
  PROFILE_OWNER_SELECT,
  PROFILE_WITH_USER_SELECT,
} from "../../lib/booking/list-selects";
import { CONSULTANT_PII_FIELDS } from "../../lib/data/consultant-public";

const mockConsultationFind = jest.fn();
const mockSubscriptionFind = jest.fn();
const mockWebinarFind = jest.fn();
const mockClassFind = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findUniqueOrThrow: (...a: unknown[]) => mockConsultationFind(...a),
    },
    subscription: {
      findUniqueOrThrow: (...a: unknown[]) => mockSubscriptionFind(...a),
    },
    webinar: {
      findUniqueOrThrow: (...a: unknown[]) => mockWebinarFind(...a),
    },
    class: { findUniqueOrThrow: (...a: unknown[]) => mockClassFind(...a) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "admin", role: "ADMIN" } },
  })),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  authorizeEventAccess: jest.fn(async () => null),
  forbiddenResponse: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../utils/appointmentlock", () => ({
  APPROVAL_LOCK_TTL_MS: 1,
  ApprovalLockLostError: class extends Error {},
  lockConsultationApproval: jest.fn(),
  renewApprovalLock: jest.fn(),
  unlockApproval: jest.fn(),
}));
jest.mock("../../lib/booking/approve-request", () => ({
  approvalMintConflict: jest.fn(),
  mintApprovalPaymentAfterCommit: jest.fn(),
}));
jest.mock("../../lib/booking/rejection-refund", () => ({
  refundRejectedRequest: jest.fn(),
}));
jest.mock("../../lib/booking/backup-interest", () => ({
  flushBackupInterestNotices: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: {} }));
jest.mock("../../lib/stream-utils", () => ({ bookingOrgId: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

function expectProjection(args: unknown, expected: unknown) {
  const profiles = expectNoBareProfile(args);
  expect(profiles).toEqual(profiles.map(() => expected));
}

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

beforeEach(() => jest.clearAllMocks());

describe("booking consultant projection (behavioural)", () => {
  it("consultation detail GET uses HOST_PROFILE_SELECT", async () => {
    mockConsultationFind.mockResolvedValue({
      consultationPlan: { consultantProfile: { id: "cp" } },
    });
    const { GET } =
      await import("../../app/api/bookings/consultations/[consultationId]/route");
    const res = await GET(new NextRequest("http://x/"), {
      params: Promise.resolve({ consultationId: ID }),
    });
    expect(res.status).toBe(200);
    expectProjection(
      mockConsultationFind.mock.calls[0][0],
      HOST_PROFILE_SELECT,
    );
  });

  it("subscription detail GET uses HOST_PROFILE_SELECT", async () => {
    mockSubscriptionFind.mockResolvedValue({
      subscriptionPlan: { consultantProfile: { id: "cp" } },
    });
    const { GET } =
      await import("../../app/api/bookings/subscriptions/[subscriptionId]/route");
    const res = await GET(new NextRequest("http://x/"), {
      params: Promise.resolve({ subscriptionId: ID }),
    });
    expect(res.status).toBe(200);
    expectProjection(
      mockSubscriptionFind.mock.calls[0][0],
      HOST_PROFILE_SELECT,
    );
  });

  it("webinar detail GET uses PROFILE_WITH_USER_SELECT", async () => {
    mockWebinarFind.mockResolvedValue({ id: "id-1" });
    const { GET } =
      await import("../../app/api/bookings/webinars/[webinarId]/route");
    const res = await GET(new NextRequest("http://x/"), {
      params: Promise.resolve({ webinarId: ID }),
    });
    expect(res.status).toBe(200);
    expectProjection(
      mockWebinarFind.mock.calls[0][0],
      PROFILE_WITH_USER_SELECT,
    );
  });

  it("class detail GET uses PROFILE_WITH_USER_SELECT", async () => {
    mockClassFind.mockResolvedValue({ id: "id-1" });
    const { GET } =
      await import("../../app/api/bookings/classes/[classId]/route");
    const res = await GET(new NextRequest("http://x/"), {
      params: Promise.resolve({ classId: ID }),
    });
    expect(res.status).toBe(200);
    expectProjection(mockClassFind.mock.calls[0][0], PROFILE_WITH_USER_SELECT);
  });
});

describe("booking consultant projection (source)", () => {
  const ROUTES = [
    [
      "app/api/bookings/consultations/[consultationId]/route.ts",
      "PARTY_PROFILE_SELECT",
    ],
    [
      "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
      "PARTY_PROFILE_SELECT",
    ],
    ["app/api/bookings/consultations/route.ts", "PROFILE_WITH_USER_SELECT"],
    ["app/api/bookings/consultations/route.ts", "PARTY_PROFILE_SELECT"],
    ["app/api/bookings/subscriptions/route.ts", "PROFILE_WITH_USER_SELECT"],
    ["app/api/bookings/subscriptions/route.ts", "PARTY_PROFILE_SELECT"],
    ["app/api/bookings/classes/[classId]/route.ts", "PROFILE_WITH_USER_SELECT"],
    [
      "app/api/bookings/webinars/[webinarId]/route.ts",
      "PROFILE_WITH_USER_SELECT",
    ],
  ];

  it.each(ROUTES)("%s uses %s", (rel, constant) => {
    expect(readSource(rel)).toContain(`consultantProfile: ${constant}`);
  });

  it.each([...new Set(ROUTES.map(([rel]) => rel))])(
    "%s never fetches the whole profile",
    (rel) => {
      const src = readSource(rel);
      expect(src).not.toMatch(/consultantProfile: true/);
      expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
      expect(src).not.toMatch(
        /consultantProfile: \{\s*select: \{[^}]*user: true/,
      );
    },
  );

  it.each([
    ["HOST_PROFILE_SELECT", HOST_PROFILE_SELECT],
    ["PARTY_PROFILE_SELECT", PARTY_PROFILE_SELECT],
    ["PARTY_USER_SELECT", PARTY_USER_SELECT],
    ["PROFILE_WITH_USER_SELECT", PROFILE_WITH_USER_SELECT],
    ["PROFILE_OWNER_SELECT", PROFILE_OWNER_SELECT],
  ])("%s carries no sensitive profile column", (_name, projection) => {
    expect(CONSULTANT_PII_FIELDS.filter((f) => hasKey(projection, f))).toEqual(
      [],
    );
  });
});
