/**
 * @jest-environment node
 */

/**
 * Funding-aware overage default: POST /api/organizations/[orgId]/programs
 * resolves an omitted `overageBehavior` via `defaultOverageBehaviorForFunding`
 * (INVOICE → CHARGE_ORG, every other rail → BLOCK) instead of silently
 * BLOCKing INVOICE programmes out of their expansion revenue.
 *
 * A defaulted CHARGE_ORG satisfies the same guards as an explicit one: a
 * positive circuit-breaker ceiling is required, and a charging behaviour on
 * an unlimited seat cap is refused.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    contract: { findUnique: jest.fn() },
    program: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/auth-helpers", () => {
  const RANK: Record<string, number> = {
    OWNER: 5,
    MAINTAINER: 4,
    MANAGER: 3,
    SUPPORT: 2,
    EXPERT: 1,
    LEARNER: 1,
  };
  return {
    requireOrgAccess: jest.fn(),
    orgRoleSatisfies: (caller: string, minimum: string) =>
      (RANK[caller] ?? 0) >= (RANK[minimum] ?? 0),
  };
});

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { POST as programsPOST } from "@/app/api/organizations/[orgId]/programs/route";

const mockedPrisma = prisma as unknown as {
  contract: { findUnique: jest.Mock };
  program: { create: jest.Mock; findMany: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function maintainerAccess() {
  return {
    error: null,
    session: { user: { id: "u-m", email: "m@test.com" } },
    member: { id: "m-actor", role: "MAINTAINER" },
    org: { id: "org-1", name: "Acme", status: "ACTIVE", canSponsor: true },
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/organizations/org-1/programs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as Request;
}

function contractRow(fundingSource: string) {
  return {
    organizationId: "org-1",
    status: "ACTIVE",
    billingAccount: { fundingSource },
  };
}

function seatBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "LICENSED_SEAT",
    contractId: "c-1",
    name: "Flagship",
    coveredPlanTypes: ["CONSULTATION"],
    licensedSeatConfig: {
      ratePerSeatPaise: 500000,
      cycle: "MONTHLY",
      coveredEngagementsPerCycle: 8,
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // NB: clearAllMocks does NOT drain mockResolvedValueOnce queues — a test
  // whose request dies at Zod-parse time never consumes its contract row, and
  // the leftover would leak into the next test. Reset the queue explicitly.
  mockedPrisma.contract.findUnique.mockReset();
  mockedRequireOrgAccess.mockResolvedValue(maintainerAccess());
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      program: mockedPrisma.program,
      orgAuditLog: mockedPrisma.orgAuditLog,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
  mockedPrisma.program.create.mockImplementation(async (args: unknown) => ({
    id: "p-1",
    ...(args as { data: Record<string, unknown> }).data,
  }));
});

describe("POST programs — funding-aware overage default", () => {
  it("INVOICE + omitted behaviour → 201 with CHARGE_ORG persisted", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("INVOICE"),
    );

    const res = await programsPOST(
      makeRequest(seatBody({ maxOveragePerCyclePaise: 1_000_000 })) as never,
      { params: Promise.resolve({ orgId: "org-1" }) } as never,
    );

    expect(res.status).toBe(201);
    expect(mockedPrisma.program.create).toHaveBeenCalledTimes(1);
    const data = mockedPrisma.program.create.mock.calls[0][0].data;
    expect(data.licensedSeatConfig.create.overageBehavior).toBe("CHARGE_ORG");
  });

  // #1744 — CHARGE_MEMBER is refused at configuration time on every rail
  // until an earnings hold exists (owner decision 2026-09-20).
  it("INVOICE + explicit CHARGE_MEMBER → 400 INVALID_OVERAGE_CONFIG", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("INVOICE"),
    );

    const res = await programsPOST(
      makeRequest(
        seatBody({
          overageBehavior: "CHARGE_MEMBER",
          maxOveragePerCyclePaise: 1_000_000,
        }),
      ) as never,
      { params: Promise.resolve({ orgId: "org-1" }) } as never,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_OVERAGE_CONFIG");
    expect(body.error).toContain("not available yet");
    expect(mockedPrisma.program.create).not.toHaveBeenCalled();
  });

  it("INVOICE + omitted behaviour + no breaker → 400 OVERAGE_BREAKER_REQUIRED", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("INVOICE"),
    );

    const res = await programsPOST(
      makeRequest(seatBody()) as never,
      {
        params: Promise.resolve({ orgId: "org-1" }),
      } as never,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("OVERAGE_BREAKER_REQUIRED");
    expect(mockedPrisma.program.create).not.toHaveBeenCalled();
  });

  it("INVOICE + unlimited cap + omitted behaviour → 201 BLOCK (nothing can overage)", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("INVOICE"),
    );

    const res = await programsPOST(
      makeRequest(seatBody({ coveredEngagementsPerCycle: null })) as never,
      { params: Promise.resolve({ orgId: "org-1" }) } as never,
    );

    expect(res.status).toBe(201);
    const data = mockedPrisma.program.create.mock.calls[0][0].data;
    expect(data.licensedSeatConfig.create.overageBehavior).toBe("BLOCK");
  });

  it("INVOICE + unlimited cap + breaker set → 400 Invalid body (parse-level dead knob)", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("INVOICE"),
    );

    const res = await programsPOST(
      makeRequest(
        seatBody({
          coveredEngagementsPerCycle: null,
          maxOveragePerCyclePaise: 1_000_000,
        }),
      ) as never,
      { params: Promise.resolve({ orgId: "org-1" }) } as never,
    );

    expect(res.status).toBe(400);
    expect(mockedPrisma.program.create).not.toHaveBeenCalled();
  });

  it("WALLET + omitted behaviour → 201 with BLOCK persisted (no breaker needed)", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("WALLET"),
    );

    // WALLET only sanctions CREDIT_POOL — use a pool body here.
    const res = await programsPOST(
      makeRequest({
        type: "CREDIT_POOL",
        contractId: "c-1",
        name: "Pool",
        coveredPlanTypes: ["CONSULTATION"],
        creditPoolConfig: { cycle: "MONTHLY", creditBudgetPerCycle: 1000 },
      }) as never,
      { params: Promise.resolve({ orgId: "org-1" }) } as never,
    );

    expect(res.status).toBe(201);
    const data = mockedPrisma.program.create.mock.calls[0][0].data;
    expect(data.creditPoolConfig.create.overageBehavior).toBe("BLOCK");
  });

  it("INVOICE + explicit BLOCK → 201 with BLOCK persisted (explicit wins)", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce(
      contractRow("INVOICE"),
    );

    const res = await programsPOST(
      makeRequest(seatBody({ overageBehavior: "BLOCK" })) as never,
      { params: Promise.resolve({ orgId: "org-1" }) } as never,
    );

    expect(res.status).toBe(201);
    const data = mockedPrisma.program.create.mock.calls[0][0].data;
    expect(data.licensedSeatConfig.create.overageBehavior).toBe("BLOCK");
  });
});
