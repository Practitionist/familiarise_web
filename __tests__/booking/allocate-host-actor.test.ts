/**
 * @jest-environment node
 */

// Invariant: allocation is host-side (plan consultant, host-org operator, staff),
// and a sponsor org allocates only a booking the expert already APPROVED.

const consultationFindUnique = jest.fn();
const membershipFindUnique = jest.fn();
const appointmentFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findUnique: (...a: unknown[]) => consultationFindUnique(...a),
    },
    membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
    appointment: { findFirst: (...a: unknown[]) => appointmentFindFirst(...a) },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../lib/auth-helpers"),
  requireOrgAccess: async () => ({
    session: { user: { id: "u-payer-owner" } },
    member: { id: "mem-1" },
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));
jest.mock("../../lib/booking/org-actor", () => ({
  isActForOrgBooking: () => true,
  isOrgFundedByOrg: async () => true,
}));
const allocate = jest.fn();
jest.mock("../../utils/scheduling-engine/SchedulingService", () => ({
  SchedulingService: { allocate: (...a: unknown[]) => allocate(...a) },
}));

import { NextRequest } from "next/server";
import { isEventHost } from "@/lib/auth-helpers";
import { POST as orgAllocate } from "@/app/api/organizations/[orgId]/appointments/[appointmentId]/allocate/route";

type HostSession = Parameters<typeof isEventHost>[0];
const sessionOf = (user: Partial<HostSession["user"]> = {}): HostSession => ({
  user: {
    id: "u-x",
    role: "CONSULTEE",
    consultantProfileId: undefined,
    ...user,
  } satisfies HostSession["user"],
});

beforeEach(() => {
  jest.clearAllMocks();
  consultationFindUnique.mockResolvedValue({
    consultationPlan: {
      consultantProfileId: "cp-host",
      organizationId: "org-host",
    },
  });
  membershipFindUnique.mockResolvedValue(null);
  allocate.mockResolvedValue({ success: true, appointments: [] });
});

describe("isEventHost", () => {
  it("refuses the consultee", async () => {
    expect(await isEventHost(sessionOf({}), "consultation", "c1")).toBe(false);
  });

  it("admits the plan's own consultant", async () => {
    const s = sessionOf({ role: "CONSULTANT", consultantProfileId: "cp-host" });
    expect(await isEventHost(s, "consultation", "c1")).toBe(true);
  });

  it("refuses a consultant who is this booking's consultee", async () => {
    const s = sessionOf({
      role: "CONSULTANT",
      consultantProfileId: "cp-other",
    });
    expect(await isEventHost(s, "consultation", "c1")).toBe(false);
  });

  it("admits an operator of the plan's host org", async () => {
    membershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
      organization: { status: "ACTIVE" },
    });
    expect(await isEventHost(sessionOf({}), "consultation", "c1")).toBe(true);
  });
});

describe("sponsor-org allocate", () => {
  const post = (status: string) => {
    appointmentFindFirst.mockResolvedValue({
      id: "appt-1",
      organizationId: "org-payer",
      consultationId: "c1",
      subscriptionId: null,
      consultation: { status },
      subscription: null,
    });
    return orgAllocate(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ isAuto: true, overrideReason: "ops request" }),
      }),
      {
        params: Promise.resolve({
          orgId: "org-payer",
          appointmentId: "appt-1",
        }),
      },
    );
  };

  it("answers 409 EXPERT_APPROVAL_REQUIRED on a PENDING booking", async () => {
    const res = await post("PENDING");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "EXPERT_APPROVAL_REQUIRED",
    });
    expect(allocate).not.toHaveBeenCalled();
  });

  it("allocates an APPROVED booking with the CAS narrowed to APPROVED", async () => {
    const res = await post("APPROVED");
    expect(res.status).toBe(200);
    expect(allocate).toHaveBeenCalledWith(
      expect.objectContaining({
        approvableFrom: ["APPROVED"],
        initialAllocation: true,
      }),
    );
  });
});
