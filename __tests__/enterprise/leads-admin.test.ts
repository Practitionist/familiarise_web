/**
 * @jest-environment node
 */

/**
 * Leads on the permission matrix (`leads.manage`, ADMIN only): the list and
 * the transition door. A transition is CAS on the prior status read in the
 * transaction, writes one `lead.transition` audit row, and a miss is 409.
 */

import { NextRequest } from "next/server";
import type { BackofficeSurface } from "../../lib/auth/backoffice-permissions";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));

const mockViewer: { role: "ADMIN" | "STAFF" | "CONSULTANT" } = {
  role: "ADMIN",
};
const mockGate = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async (surface: BackofficeSurface) => {
    mockGate(surface);
    return jest
      .requireActual<typeof import("../../lib/auth/backoffice-permissions")>(
        "../../lib/auth/backoffice-permissions",
      )
      .hasBackofficePermission(mockViewer.role, surface)
      ? { session: { user: { id: "op-1", role: mockViewer.role } } }
      : {
          error: jest
            .requireActual<typeof import("next/server")>("next/server")
            .NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
        };
  },
}));

const mockLimit = jest.fn();
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: (...args: unknown[]) => mockLimit(...args),
  adminMutationLimiter: { limit: jest.fn() },
}));

const mockLead = {
  findMany: jest.fn(),
  findUnique: jest.fn(),
  updateMany: jest.fn(),
  findUniqueOrThrow: jest.fn(),
};
const mockOpsLog = { create: jest.fn(async () => ({ id: "ops-row" })) };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    get lead() {
      return mockLead;
    },
    get opsActionLog() {
      return mockOpsLog;
    },
    $transaction: (run: (tx: unknown) => Promise<unknown>) =>
      run({ lead: mockLead, opsActionLog: mockOpsLog }),
  },
}));

import { GET } from "../../app/api/admin/leads/route";
import { PATCH } from "../../app/api/admin/leads/[leadId]/route";

function drive(body: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/admin/leads/lead_1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return PATCH(req, { params: Promise.resolve({ leadId: "lead_1" }) });
}
const reason = "Called the buyer back";

beforeEach(() => {
  jest.clearAllMocks();
  mockViewer.role = "ADMIN";
  mockLimit.mockResolvedValue(null);
  mockLead.findMany.mockResolvedValue([]);
  mockLead.findUnique.mockResolvedValue({ status: "NEW" });
  mockLead.updateMany.mockResolvedValue({ count: 1 });
  mockLead.findUniqueOrThrow.mockResolvedValue({
    id: "lead_1",
    status: "CONTACTED",
  });
});

describe("leads routes on leads.manage", () => {
  it.each([
    ["ADMIN", 200],
    ["STAFF", 403],
    ["CONSULTANT", 403],
  ] as const)("GET as %s answers %i", async (role, status) => {
    mockViewer.role = role;
    const res = await GET(new NextRequest("http://localhost/api/admin/leads"));
    expect(res.status).toBe(status);
    expect(mockGate).toHaveBeenCalledWith("leads.manage");
  });

  it("GET refuses an unknown status filter", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/leads?status=toString"),
    );
    expect(res.status).toBe(400);
    expect(mockLead.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["ADMIN", 200],
    ["STAFF", 403],
    ["CONSULTANT", 403],
  ] as const)("PATCH as %s answers %i", async (role, status) => {
    mockViewer.role = role;
    const res = await drive({ status: "CONTACTED", reason });
    expect(res.status).toBe(status);
    expect(mockGate).toHaveBeenCalledWith("leads.manage");
    expect(mockLead.updateMany).toHaveBeenCalledTimes(status === 403 ? 0 : 1);
  });
});

describe("PATCH /api/admin/leads/[leadId]", () => {
  it("needs a reason of at least five characters", async () => {
    const res = await drive({ status: "CONTACTED", reason: "ok" });
    expect(res.status).toBe(400);
    expect(mockLead.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the rate limit in front of the door", async () => {
    mockLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const res = await drive({ status: "CONTACTED", reason });
    expect(res.status).toBe(429);
    expect(mockLead.findUnique).not.toHaveBeenCalled();
  });

  it("moves the lead by CAS on its prior status and writes one audit row", async () => {
    const res = await drive({ status: "CONTACTED", reason });
    expect(res.status).toBe(200);
    expect((await res.json()).lead).toEqual({
      id: "lead_1",
      status: "CONTACTED",
    });
    expect(mockLead.updateMany).toHaveBeenCalledWith({
      where: { id: "lead_1", status: "NEW" },
      data: { status: "CONTACTED" },
    });
    expect(mockOpsLog.create).toHaveBeenCalledTimes(1);
    expect(mockOpsLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: "op-1",
          actorRole: "ADMIN",
          surface: "leads.manage",
          action: "lead.transition",
          targetKind: "Lead",
          targetId: "lead_1",
          reason,
          before: { status: "NEW" },
          after: { status: "CONTACTED" },
        }),
      }),
    );
  });

  it("409 LEAD_NOT_CLAIMABLE when another operator moved it first", async () => {
    mockLead.updateMany.mockResolvedValue({ count: 0 });
    const res = await drive({ status: "CONTACTED", reason });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LEAD_NOT_CLAIMABLE");
    expect(mockOpsLog.create).not.toHaveBeenCalled();
  });

  it("409 LEAD_NOT_CLAIMABLE for a move the flow does not allow", async () => {
    mockLead.findUnique.mockResolvedValue({ status: "CLOSED_WON" });
    const res = await drive({ status: "CLOSED_LOST", reason });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LEAD_NOT_CLAIMABLE");
    expect(mockLead.updateMany).not.toHaveBeenCalled();
  });

  it("404 for a lead that does not exist", async () => {
    mockLead.findUnique.mockResolvedValue(null);
    const res = await drive({ status: "CONTACTED", reason });
    expect(res.status).toBe(404);
  });
});
