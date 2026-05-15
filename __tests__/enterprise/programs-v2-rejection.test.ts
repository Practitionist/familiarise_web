/**
 * @jest-environment node
 */

/**
 * `POST /api/organizations/[orgId]/programs` rejects Programs v2 enum
 * values (PROJECT, RETAINER) with an explicit
 * `code: "PROGRAM_TYPE_NOT_AVAILABLE"` 400 — distinct from the generic
 * Zod-fail "Invalid body" 400 it used to return. The reject is the
 * server-side mirror of the wizard hiding these options; this test
 * pins down that the API contract surfaces a typed error so ops dashboards
 * (and customer-facing UI) can render a "coming in v2" affordance rather
 * than a confusing validation failure.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    error: null,
    membership: { id: "mock-mem", role: "OWNER" },
  })),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    contract: { findUnique: jest.fn() },
    program: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { POST } from "@/app/api/organizations/[orgId]/programs/route";

async function postBody(orgId: string, body: unknown) {
  const req = new NextRequest(`http://localhost/x/${orgId}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  // route signature: POST(req, { params: Promise<{orgId}> })
  return POST(req, { params: Promise.resolve({ orgId }) });
}

describe("Programs v2 (PROJECT, RETAINER) explicit reject", () => {
  it("PROJECT → 400 PROGRAM_TYPE_NOT_AVAILABLE", async () => {
    const res = await postBody("org-1", {
      type: "PROJECT",
      contractId: "c-1",
      name: "engagement-x",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("PROGRAM_TYPE_NOT_AVAILABLE");
    expect(json.error).toContain("PROJECT");
  });

  it("RETAINER → 400 PROGRAM_TYPE_NOT_AVAILABLE", async () => {
    const res = await postBody("org-1", {
      type: "RETAINER",
      contractId: "c-1",
      name: "monthly-retainer",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("PROGRAM_TYPE_NOT_AVAILABLE");
    expect(json.error).toContain("RETAINER");
  });

  it("garbage body still hits the Zod path (no v2 code)", async () => {
    const res = await postBody("org-1", { type: "GARBAGE" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBeUndefined();
    expect(json.error).toBe("Invalid body");
  });
});
