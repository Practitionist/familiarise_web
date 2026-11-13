/**
 * @jest-environment node
 */

// Invariant: allocation is host-side (plan consultant, host-org operator, staff);
// only the expert or staff may waive the rules; a sponsor org allocates only
// a booking the expert already APPROVED.

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
let apiUser: Record<string, unknown> = {};
jest.mock("../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: apiUser } }),
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
jest.mock("../../lib/booking/approve-request", () => ({
  mintApprovalPaymentAfterCommit: jest.fn(),
  approvalMintConflict: () => null,
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn().mockResolvedValue(undefined),
}));
const allocate = jest.fn();
jest.mock("../../lib/booking/allocation", () => ({
  allocate: (...a: unknown[]) => allocate(...a),
}));

import { NextRequest } from "next/server";
import { resolveEventHostActor } from "@/lib/auth-helpers";
import { handleAllocate } from "@/lib/scheduling/allocate-route";
import { POST as orgAllocate } from "@/app/api/organizations/[orgId]/appointments/[appointmentId]/allocate/route";

type HostSession = Parameters<typeof resolveEventHostActor>[0];
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

const hostOrgOperator = () =>
  membershipFindUnique.mockResolvedValue({
    status: "ACTIVE",
    role: "OWNER",
    organization: { status: "ACTIVE" },
  });

describe("resolveEventHostActor", () => {
  const actor = (user: Partial<HostSession["user"]>) =>
    resolveEventHostActor(sessionOf(user), "consultation", "c1");

  it("refuses the consultee", async () => {
    expect(await actor({})).toBeNull();
  });

  it("admits the plan's own consultant", async () => {
    expect(
      await actor({ role: "CONSULTANT", consultantProfileId: "cp-host" }),
    ).toBe("consultant");
  });

  it("refuses a consultant who is this booking's consultee", async () => {
    expect(
      await actor({ role: "CONSULTANT", consultantProfileId: "cp-other" }),
    ).toBeNull();
  });

  it("admits an operator of the plan's host org", async () => {
    hostOrgOperator();
    expect(await actor({})).toBe("host-org");
  });
});

describe("allocate rule-waiving flags", () => {
  const patch = () =>
    handleAllocate(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({
          isAuto: false,
          useRequestedSlots: true,
          override: true,
          allowPartial: true,
          topUp: true,
        }),
      }),
      "consultation",
      "clzzzzzzz000consultation1",
    );
  const flags = () => {
    const [request] = allocate.mock.calls[0];
    return {
      override: request.override,
      allowPartial: request.allowPartial,
      topUp: request.topUp,
    };
  };

  it("ignores them for a host-org operator", async () => {
    apiUser = { id: "u-op", role: "CONSULTEE" };
    hostOrgOperator();
    expect((await patch()).status).toBe(200);
    expect(flags()).toEqual({
      override: false,
      allowPartial: false,
      topUp: false,
    });
  });

  it("marks only the plan's own consultant as the consultant", async () => {
    apiUser = { id: "u-op", role: "CONSULTEE" };
    hostOrgOperator();
    await patch();
    expect(allocate.mock.calls[0][0].byConsultant).toBe(false);
    allocate.mockClear();
    apiUser = {
      id: "u-cp",
      role: "CONSULTANT",
      consultantProfileId: "cp-host",
    };
    await patch();
    expect(allocate.mock.calls[0][0].byConsultant).toBe(true);
  });

  it("records the actor, and an org audit row for a host-org operator", async () => {
    apiUser = { id: "u-op", role: "CONSULTEE" };
    membershipFindUnique.mockResolvedValue({
      id: "mem-op",
      status: "ACTIVE",
      role: "OWNER",
      organization: { status: "ACTIVE" },
    });
    await patch();
    const [request] = allocate.mock.calls[0];
    expect(request.actorUserId).toBe("u-op");
    const orgAuditLog = { create: jest.fn() };
    await request.inTx({ orgAuditLog });
    expect(orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-host",
        actorMembershipId: "mem-op",
        action: "APPOINTMENT_ALLOCATED_FOR_ORG",
      }),
    });
  });

  it("honours them for the plan's own consultant", async () => {
    apiUser = {
      id: "u-cp",
      role: "CONSULTANT",
      consultantProfileId: "cp-host",
    };
    expect((await patch()).status).toBe(200);
    expect(flags()).toEqual({
      override: true,
      allowPartial: true,
      topUp: true,
    });
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

  it("is never the consultant's own choice, so it records no Auto consent", async () => {
    await post("APPROVED");
    expect(allocate.mock.calls[0][0].byConsultant).toBeUndefined();
  });

  it("allocates an APPROVED booking with the CAS narrowed to APPROVED", async () => {
    const res = await post("APPROVED");
    expect(res.status).toBe(200);
    expect(allocate).toHaveBeenCalledWith(
      expect.objectContaining({
        approvableFrom: ["APPROVED"],
        initialAllocation: true,
        actorUserId: "u-payer-owner",
      }),
    );
  });
});
