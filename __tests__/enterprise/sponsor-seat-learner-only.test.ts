/**
 * @jest-environment node
 */

/**
 * A sponsored seat goes only to an ACTIVE LEARNER of the org, and never to the
 * operator assigning it, so org money cannot fund an operator's or expert's
 * own bookings.
 */

const mockRequireOrgAccess = jest.fn();
const mockProgramFindFirst = jest.fn();
const mockMembershipFindFirst = jest.fn();
const mockClaimProgramAssignment = jest.fn();
const mockAdjustActiveSeatCount = jest.fn();
const mockAuditCreate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    program: { findFirst: (...a: unknown[]) => mockProgramFindFirst(...a) },
    // The membership read lives INSIDE the transaction now, so it is reached
    // through `tx`, not the top-level client.
    $transaction: (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        membership: {
          findFirst: (...a: unknown[]) => mockMembershipFindFirst(...a),
        },
        program: { updateMany: jest.fn() },
        webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
        outboundWebhookDelivery: { createMany: jest.fn() },
        orgAuditLog: { create: (...a: unknown[]) => mockAuditCreate(...a) },
        notificationOutbox: {
          upsert: jest.fn().mockResolvedValue({ id: "outbox-1" }),
        },
        user: { findMany: jest.fn().mockResolvedValue([]) },
        failedEmail: { create: jest.fn().mockResolvedValue({ id: "fe-1" }) },
        emailSuppression: { findMany: jest.fn().mockResolvedValue([]) },
      }),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  claimProgramAssignment: (...a: unknown[]) => mockClaimProgramAssignment(...a),
}));

jest.mock("../../lib/api/organizations/seat-count", () => ({
  __esModule: true,
  adjustActiveSeatCount: (...a: unknown[]) => mockAdjustActiveSeatCount(...a),
}));

import { POST } from "../../app/api/organizations/[orgId]/programs/[programId]/assignments/route";

const ORG = "org-acme";
const PROGRAM = "program-1";
const MEMBERSHIP = "membership-1";

function request() {
  return new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify({
      membershipId: MEMBERSHIP,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
    }),
  }) as never;
}

function params() {
  return { params: Promise.resolve({ orgId: ORG, programId: PROGRAM }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgAccess.mockResolvedValue({
    session: { user: { id: "user-1" } },
    member: { id: "actor-membership", role: "MAINTAINER" },
    org: { id: ORG, canSponsor: true },
  });
  mockProgramFindFirst.mockResolvedValue({ id: PROGRAM, status: "ACTIVE" });
  mockClaimProgramAssignment.mockResolvedValue({
    assignment: { id: "assignment-1" },
    created: true,
  });
  mockAuditCreate.mockResolvedValue({});
});

describe("sponsored seats are for learners only", () => {
  it("assigns a seat to an ACTIVE LEARNER", async () => {
    mockMembershipFindFirst.mockResolvedValue({
      id: MEMBERSHIP,
      status: "ACTIVE",
      role: "LEARNER",
    });
    const res = await POST(request(), params());
    expect(res.status).toBe(201);
    expect(mockClaimProgramAssignment).toHaveBeenCalledTimes(1);
  });

  it.each(["EXPERT", "MANAGER", "MAINTAINER", "OWNER", "SUPPORT"])(
    "refuses a %s membership with 409 SPONSOR_SEAT_ROLE and takes no seat",
    async (role) => {
      mockMembershipFindFirst.mockResolvedValue({
        id: MEMBERSHIP,
        status: "ACTIVE",
        role,
      });
      const res = await POST(request(), params());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "Sponsored seats are for learners in your organisation",
        code: "SPONSOR_SEAT_ROLE",
      });
      expect(mockClaimProgramAssignment).not.toHaveBeenCalled();
      expect(mockAdjustActiveSeatCount).not.toHaveBeenCalled();
    },
  );

  it("refuses the operator's own membership with 409 SPONSOR_SELF", async () => {
    mockMembershipFindFirst.mockResolvedValue({
      id: "actor-membership",
      status: "ACTIVE",
      role: "MANAGER",
    });
    const res = await POST(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({
          membershipId: "actor-membership",
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-12-01T00:00:00.000Z",
        }),
      }) as never,
      params(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SPONSOR_SELF");
    expect(mockClaimProgramAssignment).not.toHaveBeenCalled();
  });
});
