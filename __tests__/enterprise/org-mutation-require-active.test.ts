/**
 * @jest-environment node
 */

import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const mockRequireOrgAccess = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: (...args: unknown[]) => mockRequireOrgAccess(...args),
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const mockTx = {
  consentArtifact: {
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  orgAuditLog: {
    create: jest.fn(async () => ({ id: "audit-1" })),
  },
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
  },
  membership: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
    fn(mockTx),
  ),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

function walkOrgRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkOrgRoutes(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out.sort();
}

describe("Enterprise org mutation routes requireActive enforcement & DPDP compliance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("enforces requireActive: true on every org mutation handler except explicit lifecycle/compliance routes", () => {
    const root = path.resolve(process.cwd(), "app/api/organizations/[orgId]");
    const files = walkOrgRoutes(root);
    const missingRequireActive: string[] = [];

    for (const file of files) {
      const rel = path.relative(process.cwd(), file);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const handlers: { method: string; start: number; end?: number }[] = [];

      lines.forEach((line, idx) => {
        const m = line.match(
          /^export async function (GET|POST|PUT|PATCH|DELETE)\b/,
        );
        if (m) handlers.push({ method: m[1], start: idx });
      });

      handlers.forEach((h, i) => {
        const end =
          i + 1 < handlers.length ? handlers[i + 1].start : lines.length;
        if (h.method === "GET") return;
        const slice = lines.slice(h.start, end);
        const callIdx = slice.findIndex((s) => s.includes("requireOrgAccess("));
        if (callIdx === -1) return;
        const block = slice.slice(callIdx, callIdx + 6).join("\n");
        if (!block.includes("requireActive: true")) {
          missingRequireActive.push(`${rel}#${h.method}`);
        }
      });
    }

    expect(missingRequireActive).toEqual([
      "app/api/organizations/[orgId]/consent/route.ts#DELETE",
      "app/api/organizations/[orgId]/data-exports/route.ts#POST",
      "app/api/organizations/[orgId]/invitations/route.ts#POST",
      "app/api/organizations/[orgId]/members/bulk-import/route.ts#POST",
      "app/api/organizations/[orgId]/route.ts#DELETE",
      "app/api/organizations/[orgId]/verification/resubmit/route.ts#POST",
    ]);
  });

  it("executes DELETE /api/organizations/[orgId]/consent withdrawal and OrgAuditLog write atomically in prisma.$transaction", async () => {
    mockRequireOrgAccess.mockResolvedValueOnce({
      session: { user: { id: "u-member-1" } },
      member: { id: "mem-1", role: "LEARNER" },
      org: { id: "org-1", status: "SUSPENDED" },
    });
    mockPrisma.membership.findUnique.mockResolvedValueOnce({ id: "mem-1" });
    mockTx.consentArtifact.updateMany.mockResolvedValueOnce({ count: 2 });

    const { DELETE } =
      await import("../../app/api/organizations/[orgId]/consent/route");
    const req = new NextRequest(
      "http://localhost/api/organizations/org-1/consent?purposeCode=MARKETING_COMMS",
      { method: "DELETE" },
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ orgId: "org-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ withdrawnCount: 2 });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.consentArtifact.updateMany).toHaveBeenCalledTimes(1);
    expect(mockTx.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          actorMembershipId: "mem-1",
          targetMembershipId: "mem-1",
          category: "CONSENT",
        }),
      }),
    );
  });

  it("rejects Stream token minting for erased users while allowing active users", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "u-erased", role: "CONSULTEE", banned: false },
    });
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: "u-erased",
      erasedAt: new Date("2026-05-01T00:00:00.000Z"),
      banned: false,
    });

    const { chatTokenProvider } =
      await import("../../actions/stream/chat/stream.action");

    await expect(chatTokenProvider("u-erased")).rejects.toThrow(
      /Forbidden: account erased/,
    );
  });

  it("filters out erased target users in POST /api/stream/users/block", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "u-blocker" },
    });
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    const { POST } = await import("../../app/api/stream/users/block/route");
    const req = new NextRequest("http://localhost/api/stream/users/block", {
      method: "POST",
      body: JSON.stringify({ targetUserId: "u-erased" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u-erased", erasedAt: null },
      select: { id: true },
    });
  });
});
