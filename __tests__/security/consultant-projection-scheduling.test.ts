/**
 * @jest-environment node
 */

/**
 * Scheduling routes: every `consultantProfile` relation they read is a shared
 * projection, never a bare `true` or an `include`, so the response cannot carry
 * the sensitive profile columns.
 */

import {
  expectNoBareProfile,
  hasKey,
  readSource,
  valuesAtKey,
} from "../fixtures/consultant-projection";
import { NextRequest } from "next/server";
import {
  PARTY_PROFILE_SELECT,
  PROFILE_WITH_USER_SELECT,
} from "../../lib/booking/list-selects";
import { CONSULTANT_PII_FIELDS } from "../../lib/data/consultant-public";

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockConsultationCreate = jest.fn();
const mockRequireApiAuth = jest.fn();

jest.mock("../../lib/prisma", () => {
  const created = () => ({
    id: "req_1",
    requestedAt: new Date(),
    consultationPlan: {
      title: "Plan",
      consultantProfile: {
        id: "cp_1",
        user: { id: "user_consultant", name: "Olivia" },
      },
    },
    requestedBy: { user: { name: "Sam" } },
    appointment: { id: "apt_1", organizationId: null, occurrences: [] },
  });
  const db: Record<string, unknown> = {
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    consulteeProfile: {
      findUnique: jest.fn(async () => ({ id: "cs_1", user: {} })),
    },
    consultationPlan: {
      findFirst: jest.fn(async () => ({
        id: "plan_1",
        title: "Plan",
        consultantProfile: {
          id: "cp_1",
          acceptingRequests: true,
          maxOpenRequests: null,
          user: { id: "user_consultant", name: "Olivia" },
        },
      })),
    },
    consultation: {
      count: jest.fn(async () => 0),
      create: (...a: unknown[]) => {
        mockConsultationCreate(...a);
        return created();
      },
    },
    subscription: { count: jest.fn(async () => 0) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockRequireApiAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));
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
jest.mock("../../utils/appointmentlock", () => ({
  lockSlotBooking: jest.fn(async () => ({ key: "slot" })),
  unlockSlotBooking: jest.fn(async () => undefined),
  lockConsulteeBooking: jest.fn(async () => ({ key: "consultee" })),
  unlockConsulteeBooking: jest.fn(async () => undefined),
  BookingLockUnavailableError: class extends Error {},
  LockContentionError: class extends Error {},
}));
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: class {
    checkSlotAvailability = async () => ({
      isValid: true,
      errors: [],
      warnings: [],
      conflicts: [],
    });
  },
}));
jest.mock("../../lib/novu", () => ({
  notifyNewBookingRequest: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/novu/workflows", () => ({
  ...jest.requireActual("../../lib/novu/workflows"),
  notificationScope: () => ({ organizationId: null, scope: "personal" }),
}));
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
  ...jest.requireActual("../../lib/booking/participants"),
  recordParticipants: jest.fn(async () => undefined),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { getConsultantAppointments } from "../../lib/data/consultant-appointments";

beforeEach(() => jest.clearAllMocks());

describe("scheduling consultant projection (behavioural)", () => {
  it("appointment detail reads every consultantProfile as PARTY_PROFILE_SELECT", async () => {
    mockRequireApiAuth.mockResolvedValue({
      session: { user: { id: "admin", role: "ADMIN" } },
    });
    mockAppointmentFindUnique.mockResolvedValue({
      id: "appt-1",
      payment: [],
      participants: [],
    });
    const { GET } =
      await import("../../app/api/scheduling/appointments/[appointmentId]/route");
    const res = await GET(new Request("http://x") as never, {
      params: Promise.resolve({ appointmentId: "appt-1" }),
    });
    expect(res.status).toBe(200);
    const args = mockAppointmentFindUnique.mock.calls[0][0];
    expectNoBareProfile(args);
    expect(valuesAtKey(args, "consultantProfile")).toEqual(
      valuesAtKey(args, "consultantProfile").map(() => PARTY_PROFILE_SELECT),
    );
  });

  it("getConsultantAppointments selects id, userId and a user projection only", async () => {
    mockAppointmentFindMany.mockResolvedValue([]);
    await getConsultantAppointments({
      consultantProfileId: "cp-1",
      scope: { kind: "personal" },
    });
    const args = mockAppointmentFindMany.mock.calls[0][0];
    expectNoBareProfile(args);
    const profiles = valuesAtKey(args, "consultantProfile");
    expect(
      profiles.map((p) => Object.keys((p as { select: object }).select)),
    ).toEqual(profiles.map(() => ["id", "userId", "user"]));
  });

  it("request-for-approval creates the consultation with PROFILE_WITH_USER_SELECT", async () => {
    const { POST } =
      await import("../../app/api/scheduling/request-for-approval/route");
    const res = await POST(
      new NextRequest("https://x.test/api/scheduling/request-for-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consultantProfileId: "cp_1",
          consultationPlanId: "plan_1",
          startsAt: "2030-01-01T10:00:00.000Z",
          endsAt: "2030-01-01T11:00:00.000Z",
          availabilityWindowWeeklyId: "aw_1",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const args = mockConsultationCreate.mock.calls[0][0];
    expectNoBareProfile(args);
    expect(valuesAtKey(args, "consultantProfile")).toEqual([
      PROFILE_WITH_USER_SELECT,
    ]);
  });
});

describe("scheduling consultant projection (source)", () => {
  const ROUTES = [
    {
      rel: "app/api/scheduling/appointments/[appointmentId]/route.ts",
      constant: "PARTY_PROFILE_SELECT",
    },
    {
      rel: "app/api/scheduling/request-for-approval/route.ts",
      constant: "PROFILE_WITH_USER_SELECT",
    },
  ];

  it.each(ROUTES)("$rel uses $constant", ({ rel, constant }) => {
    const src = readSource(rel);
    expect(src).toContain(`consultantProfile: ${constant}`);
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
    expect(src).not.toMatch(
      /consultantProfile: \{\s*select: \{[^}]*user: true/,
    );
  });

  it("the appointments reader never fetches the whole profile", () => {
    const src = readSource("lib/data/consultant-appointments.ts");
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
    expect(src).not.toMatch(
      /consultantProfile: \{\s*select: \{[^}]*user: true/,
    );
    expect(src).toMatch(/consultantProfile: \{\s*select: \{\s*id: true,/);
  });

  it.each([
    ["PARTY_PROFILE_SELECT", PARTY_PROFILE_SELECT],
    ["PROFILE_WITH_USER_SELECT", PROFILE_WITH_USER_SELECT],
  ])("%s carries no sensitive profile column", (_name, projection) => {
    expect(CONSULTANT_PII_FIELDS.filter((f) => hasKey(projection, f))).toEqual(
      [],
    );
  });
});
