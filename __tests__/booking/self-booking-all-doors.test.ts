/**
 * @jest-environment node
 */

/**
 * Nobody books, requests, trials or waits on their own plan: every buyer door
 * refuses with 409 SELF_BOOKING through the one `assertNotSelfBooking` rule,
 * and request-for-approval tags an org only through a LEARNER membership.
 * Collaborators are boundary-mocked as in consultant-request-gate.test.ts.
 */

import { requestDoorProfile } from "../fixtures/request-door-db";

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: mockSessionUser })),
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
const mockLockRequestCap = jest.fn(async () => ({ key: "request-cap" }));
jest.mock("../../utils/appointmentlock", () => ({
  lockSlotBatch: (...a: unknown[]) => mockLockSlotBooking(...(a as [])),
  unlockSlotInterval: jest.fn(async () => undefined),
  lockConsulteeBooking: jest.fn(async () => ({ key: "consultee" })),
  unlockConsulteeBooking: jest.fn(async () => undefined),
  lockRequestCap: (...a: unknown[]) => mockLockRequestCap(...(a as [])),
  unlockRequestCap: jest.fn(async () => undefined),
  BookingLockUnavailableError: class extends Error {},
  LockContentionError: class extends Error {},
  RequestCapBusyError: class extends Error {},
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
// The expiry sweep the route's module imports ends Stream access; no door here reaches it.
jest.mock("../../lib/stream/access-revocation", () => ({
  revokeEndedSeatAccess: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const mockSessionUser: { id: string; consultantProfileId?: string } = {
  id: "user_consultee",
};
const mockOrgMembership = { status: "ACTIVE", role: "LEARNER" };
const mockConsultationCount = jest.fn(async () => 0);
const mockSubscriptionCount = jest.fn(async () => 0);
const mockTrialCount = jest.fn(async () => 0);
const mockProfile = requestDoorProfile();
jest.mock("../../lib/booking/allocation/coverage", () =>
  jest.requireActual("../fixtures/request-door-hours"),
);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual("../fixtures/request-door-db").requestDoorDb(
    () => mockProfile,
    {
      consultation: (...a: unknown[]) => mockConsultationCount(...(a as [])),
      subscription: (...a: unknown[]) => mockSubscriptionCount(...(a as [])),
      trial: (...a: unknown[]) => mockTrialCount(...(a as [])),
    },
    {
      organization: {
        findUnique: jest.fn(async () => ({
          canSponsor: true,
          status: "ACTIVE",
        })),
      },
      membership: { findUnique: jest.fn(async () => mockOrgMembership) },
    },
  ),
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/scheduling/request-for-approval/route";
import { assertNotSelfBooking } from "../../lib/booking/self-booking";
import { isRefusal } from "../../lib/errors/refusal";
import { freezeDateAt } from "../fixtures/frozen-date";

function request(extra: Record<string, unknown> = {}) {
  return new NextRequest("https://x.test/api/scheduling/request-for-approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "cp_1",
      consultationPlanId: "plan_1",
      startsAt: "2030-01-01T10:00:00.000Z",
      endsAt: "2030-01-01T11:00:00.000Z",
      availabilityWindowWeeklyId: "aw_1",
      ...extra,
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // The 2030 fixtures sit a few weeks ahead, inside the booking horizon.
  freezeDateAt("2029-12-10T00:00:00.000Z");
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockSessionUser.consultantProfileId = undefined;
  mockOrgMembership.role = "LEARNER";
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("assertNotSelfBooking", () => {
  const refusalOf = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };

  it("refuses the plan owner and an ACCEPTED co-host", () => {
    for (const plan of [
      { consultantProfileId: "cp_me" },
      { consultantProfileId: "cp_other", collaboratorProfileIds: ["cp_me"] },
    ]) {
      const error = refusalOf(() => assertNotSelfBooking("cp_me", plan));
      expect(isRefusal(error) && error.code).toBe("SELF_BOOKING");
      expect(isRefusal(error) && error.httpStatus).toBe(409);
    }
  });

  it("lets a learner without a consultant profile, or another expert, through", () => {
    expect(() =>
      assertNotSelfBooking(null, { consultantProfileId: "cp_1" }),
    ).not.toThrow();
    expect(() =>
      assertNotSelfBooking("cp_me", { consultantProfileId: "cp_1" }),
    ).not.toThrow();
  });
});

describe("request-for-approval", () => {
  it("an expert requesting their own plan gets 409 SELF_BOOKING before any lock", async () => {
    mockSessionUser.consultantProfileId = "cp_1";
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SELF_BOOKING");
    expect(mockLockRequestCap).not.toHaveBeenCalled();
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
  });

  it("an expert requesting another expert's plan proceeds", async () => {
    mockSessionUser.consultantProfileId = "cp_other";
    const res = await POST(request());
    expect(res.status).toBe(201);
  });

  it.each(["EXPERT", "MANAGER", "OWNER"])(
    "a %s membership cannot tag the request to the org: 409 SPONSOR_SEAT_ROLE",
    async (role) => {
      mockOrgMembership.role = role;
      const res = await POST(request({ organizationId: "org_b" }));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("SPONSOR_SEAT_ROLE");
      expect(mockLockRequestCap).not.toHaveBeenCalled();
    },
  );

  it("a LEARNER membership tags the request", async () => {
    const res = await POST(request({ organizationId: "org_b" }));
    expect(res.status).toBe(201);
  });
});

describe("the other doors call the same rule", () => {
  const { readFileSync } = jest.requireActual<typeof import("fs")>("fs");
  it.each([
    "lib/payments/checkout/revalidate.ts",
    "app/api/trials/route.ts",
    "app/api/scheduling/backup-interest/route.ts",
    "app/api/scheduling/request-for-approval/route.ts",
  ])("%s", (rel) => {
    expect(readFileSync(rel, "utf8")).toMatch(/assertNotSelfBooking\(/);
  });
});
