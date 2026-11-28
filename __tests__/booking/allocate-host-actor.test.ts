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
const stageFreed = jest.fn(async (..._args: unknown[]) => ({
  bells: [{ id: "bell_1" }],
  emails: [],
}));
const flushFreed = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../../lib/booking/backup-interest", () => ({
  stageNoticesForFreedWindows: (...a: unknown[]) => stageFreed(...a),
  flushBackupInterestNotices: (...a: unknown[]) => flushFreed(...a),
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
    await request.inTx(
      { orgAuditLog },
      { consultantProfileId: "cp-host", freedWindows: [], placed: [] },
    );
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

  it("refuses a picked time off the half-hour grid, as every other allocate door does", async () => {
    const res = await orgAllocate(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({
          isAuto: false,
          slots: ["2026-12-01T10:15:00.000Z"],
          overrideReason: "ops request",
        }),
      }),
      {
        params: Promise.resolve({
          orgId: "org-payer",
          appointmentId: "appt-1",
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Times start on the hour or half hour",
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
        actorUserId: "u-payer-owner",
      }),
    );
  });
});

describe("a booking re-placed through the allocate route", () => {
  const FREED = {
    startsAt: new Date("2026-12-01T10:00:00.000Z"),
    endsAt: new Date("2026-12-01T11:00:00.000Z"),
  };
  const PLACED = {
    startsAt: new Date("2026-12-03T10:00:00.000Z"),
    endsAt: new Date("2026-12-03T11:00:00.000Z"),
  };

  it("tells the learners waiting on the time it freed, in the allocation's transaction, and sends after the commit", async () => {
    apiUser = {
      id: "u-cp",
      role: "CONSULTANT",
      consultantProfileId: "cp-host",
    };
    const tx = { marker: "allocation-tx" };
    allocate.mockImplementation(
      async (req: {
        inTx?: (tx: unknown, moved: unknown) => Promise<void>;
      }) => {
        await req.inTx?.(tx, {
          consultantProfileId: "cp-host",
          freedWindows: [FREED],
          placed: [PLACED],
        });
        return { success: true, appointments: [] };
      },
    );

    const res = await handleAllocate(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ isAuto: false, slots: [PLACED.startsAt] }),
      }),
      "consultation",
      "clzzzzzzz000consultation1",
    );

    expect(res.status).toBe(200);
    expect(stageFreed).toHaveBeenCalledWith(tx, "cp-host", [FREED], [PLACED]);
    expect(flushFreed).toHaveBeenCalledWith({
      bells: [{ id: "bell_1" }],
      emails: [],
    });
  });
});

describe("an allocation refusal carries what the client acts on", () => {
  const TAKEN = "2026-12-01T10:00:00.000Z";
  const viaExpert = () => {
    apiUser = {
      id: "u-cp",
      role: "CONSULTANT",
      consultantProfileId: "cp-host",
    };
    return handleAllocate(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ isAuto: false, slots: [TAKEN] }),
      }),
      "consultation",
      "clzzzzzzz000consultation1",
    );
  };
  const viaSponsorOrg = () => {
    appointmentFindFirst.mockResolvedValue({
      id: "appt-1",
      organizationId: "org-payer",
      consultationId: "c1",
      subscriptionId: null,
      consultation: { status: "APPROVED" },
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

  it.each([
    ["the expert's route", viaExpert],
    ["the sponsor organisation's route", viaSponsorOrg],
  ])("%s names the taken times", async (_, call) => {
    allocate.mockResolvedValue({
      success: false,
      error: "One of these times was just taken.",
      errorCode: "TIMES_TAKEN",
      httpStatus: 409,
      takenSlotStarts: [TAKEN],
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).takenSlotStarts).toEqual([TAKEN]);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it.each([
    ["the expert's route", viaExpert],
    ["the sponsor organisation's route", viaSponsorOrg],
  ])("%s says when to retry a lost race", async (_, call) => {
    allocate.mockResolvedValue({
      success: false,
      error: "Someone else is booking right now.",
      errorCode: "ALLOCATION_RACE",
      httpStatus: 409,
      retryAfterSeconds: 5,
    });
    const res = await call();
    expect((await res.json()).retryAfterSeconds).toBe(5);
    expect(res.headers.get("Retry-After")).toBe("5");
  });
});
