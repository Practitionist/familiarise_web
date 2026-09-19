/**
 * @jest-environment node
 */

/**
 * #1703 D4 — the consultant-side gate on POST /api/scheduling/request-for-approval:
 * a paused profile answers 409 CONSULTANT_PAUSED before any lock; a profile at
 * its open-request cap answers 409 CONSULTANT_AT_CAPACITY from a count taken
 * inside the slot lock; below the cap the request is created (201).
 *
 * Collaborators are boundary-mocked: auth, the limiter, the locks, the
 * validator, the notifiers. What is under test is the gate and its codes.
 */

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "user_consultee" } })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  requestApprovalLimiter: {},
}));
jest.mock("../../lib/profiles/ensure-consultee-profile", () => ({
  ensureConsulteeProfile: jest.fn(async () => undefined),
}));
const mockLockSlotBooking = jest.fn(async () => ({ key: "slot" }));
jest.mock("../../utils/appointmentlock", () => ({
  lockSlotBooking: (...a: unknown[]) => mockLockSlotBooking(...(a as [])),
  unlockSlotBooking: jest.fn(async () => undefined),
  lockConsulteeBooking: jest.fn(async () => ({ key: "consultee" })),
  unlockConsulteeBooking: jest.fn(async () => undefined),
  BookingLockUnavailableError: class extends Error {},
  LockContentionError: class extends Error {},
}));
const mockCheckSlotAvailability = jest.fn(async () => ({
  isValid: true,
  errors: [] as string[],
  warnings: [] as string[],
  conflicts: [] as { otherParty: { userId: string } | null }[],
}));
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: class {
    checkSlotAvailability = (...a: unknown[]) =>
      mockCheckSlotAvailability(...(a as []));
  },
}));
jest.mock("../../lib/novu", () => ({
  notifyNewBookingRequest: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/novu/workflows", () => ({
  ...jest.requireActual("../../lib/novu/workflows"),
  notificationScope: () => ({ organizationId: null, scope: "personal" }),
}));
// The route imports the stale-request sweep for its window constant, and the
// sweep's nudge pass (#1703) pulls the Novu service and outbox.
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/novu/outbox", () => ({ deriveTransactionId: jest.fn() }));
jest.mock("../../lib/novu/resolve-href", () => ({ scopedHref: () => "/x" }));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  sendNewBookingRequestEmail: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/booking/transitions", () => ({
  appendCreationHistory: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/participants", () => ({
  recordParticipants: jest.fn(async () => undefined),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const mockConsultationCount = jest.fn(async () => 0);
const mockSubscriptionCount = jest.fn(async () => 0);
const mockProfile = {
  id: "cp_1",
  acceptingRequests: true,
  maxOpenRequests: null as number | null,
  user: { id: "user_consultant", name: "Olivia" },
};
jest.mock("../../lib/prisma", () => {
  const created = () => ({
    id: "req_1",
    requestedAt: new Date(),
    consultationPlan: { title: "Plan", consultantProfile: mockProfile },
    requestedBy: { user: { name: "Sam" } },
    appointment: { id: "apt_1", organizationId: null, occurrences: [] },
  });
  const db: Record<string, unknown> = {
    consulteeProfile: {
      findUnique: jest.fn(async () => ({ id: "cs_1", user: {} })),
    },
    consultationPlan: {
      findFirst: jest.fn(async () => ({
        id: "plan_1",
        title: "Plan",
        consultantProfile: mockProfile,
      })),
    },
    consultation: {
      count: (...a: unknown[]) => mockConsultationCount(...(a as [])),
      create: jest.fn(async () => created()),
    },
    subscription: {
      count: (...a: unknown[]) => mockSubscriptionCount(...(a as [])),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { __esModule: true, default: db };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/scheduling/request-for-approval/route";

function request(startsAt = "2030-01-01T10:00:00.000Z") {
  return new NextRequest("https://x.test/api/scheduling/request-for-approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "cp_1",
      consultationPlanId: "plan_1",
      startsAt,
      endsAt: "2030-01-01T11:00:00.000Z",
      availabilityWindowWeeklyId: "aw_1",
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockProfile.acceptingRequests = true;
  mockProfile.maxOpenRequests = null;
});
afterEach(() => jest.restoreAllMocks());

describe("consultant request gate", () => {
  it("paused → 409 CONSULTANT_PAUSED before any lock", async () => {
    mockProfile.acceptingRequests = false;
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_PAUSED");
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
  });

  it("at cap → 409 CONSULTANT_AT_CAPACITY, counted inside the slot lock", async () => {
    mockProfile.maxOpenRequests = 3;
    // The per-consultee count answers first (0), then the consultant count.
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    mockSubscriptionCount.mockResolvedValueOnce(1);
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_AT_CAPACITY");
    expect(mockLockSlotBooking).toHaveBeenCalledTimes(1);
    // The consultant count (second count call) runs after the lock, not before.
    expect(mockConsultationCount.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockLockSlotBooking.mock.invocationCallOrder[0],
    );
  });

  it("below cap → 201", async () => {
    mockProfile.maxOpenRequests = 3;
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mockSubscriptionCount.mockResolvedValueOnce(1);
    const res = await POST(request());
    expect(res.status).toBe(201);
  });
});

// #1583 B-P1-06 / E-P1-03 — the Zod edge refuses off-grid and too-soon
// starts with a typed code, and the in-lock check sees the consultee too.
describe("request-for-approval slot edge (#1583)", () => {
  it("10:07Z → 400 SLOT_NOT_ON_GRID before any lock", async () => {
    const res = await POST(request("2030-01-01T10:07:00.000Z"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SLOT_NOT_ON_GRID");
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
  });

  it("two minutes ahead → 400 SLOT_TOO_SOON", async () => {
    const soon = new Date(Date.now() + 2 * 60 * 1000);
    soon.setUTCSeconds(0, 0);
    soon.setUTCMinutes(soon.getUTCMinutes() < 30 ? 0 : 30);
    const res = await POST(request(soon.toISOString()));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SLOT_TOO_SOON");
  });

  it("passes the consultee to the conflict check and types their own overlap as 409 SLOT_TAKEN", async () => {
    mockCheckSlotAvailability.mockResolvedValueOnce({
      isValid: false,
      errors: ["[CONFLICT] Slot already booked"],
      warnings: [],
      conflicts: [{ otherParty: { userId: "user_consultee" } }],
    });
    const res = await POST(request());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SLOT_TAKEN");
    expect(body.error).toMatch(/already have a session/);
    expect(body.details).toBeUndefined();
    expect(mockCheckSlotAvailability).toHaveBeenCalledWith(
      expect.any(Array),
      "user_consultant",
      "cp_1",
      "user_consultee",
    );
  });
});
