/**
 * @jest-environment node
 */

/**
 * Scheduling routes: every `consultantProfile` relation they read is a shared
 * projection, never a bare `true` or an `include`, so the response cannot carry
 * the sensitive profile columns. Request-for-approval is driven in
 * `__tests__/booking-algorithm/consultant-request-gate.test.ts`, which owns its mocks.
 */

import {
  expectNoBareProfile,
  hasKey,
  readSource,
  valuesAtKey,
} from "../fixtures/consultant-projection";
import {
  HOST_PROFILE_SELECT,
  PARTY_PROFILE_SELECT,
  PROFILE_WITH_USER_SELECT,
} from "../../lib/booking/list-selects";
import { CONSULTANT_PII_FIELDS } from "../../lib/data/consultant-public";

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockRequireApiAuth = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockRequireApiAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { getConsultantAppointments } from "../../lib/data/consultant-appointments";

beforeEach(() => jest.clearAllMocks());

describe("scheduling consultant projection (behavioural)", () => {
  it("appointment detail gives 1:1 parties the party select and seat holders the host select", async () => {
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
    const planProfile = (event: string, plan: string) =>
      args.include[event].include[plan].include.consultantProfile;
    expect(planProfile("consultation", "consultationPlan")).toEqual(
      PARTY_PROFILE_SELECT,
    );
    expect(planProfile("subscription", "subscriptionPlan")).toEqual(
      PARTY_PROFILE_SELECT,
    );
    expect(planProfile("webinar", "webinarPlan")).toEqual(HOST_PROFILE_SELECT);
    expect(planProfile("class", "classPlan")).toEqual(HOST_PROFILE_SELECT);
    expect(hasKey(HOST_PROFILE_SELECT, "email")).toBe(false);
    expect(valuesAtKey(args, "consultantProfile")).toHaveLength(4);
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

  it("the appointments list answers 400 for a request status the enum no longer has", async () => {
    mockRequireApiAuth.mockResolvedValue({
      session: { user: { id: "admin", role: "ADMIN" } },
    });
    const { GET } = await import("../../app/api/scheduling/appointments/route");
    const res = await GET(
      new Request(
        "http://x/api/scheduling/appointments?consultationStatus=SCHEDULED",
      ) as never,
    );
    expect(res.status).toBe(400);
    expect(mockAppointmentFindMany).not.toHaveBeenCalled();
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
    ["HOST_PROFILE_SELECT", HOST_PROFILE_SELECT],
    ["PARTY_PROFILE_SELECT", PARTY_PROFILE_SELECT],
    ["PROFILE_WITH_USER_SELECT", PROFILE_WITH_USER_SELECT],
  ])("%s carries no sensitive profile column", (_name, projection) => {
    expect(CONSULTANT_PII_FIELDS.filter((f) => hasKey(projection, f))).toEqual(
      [],
    );
  });
});
