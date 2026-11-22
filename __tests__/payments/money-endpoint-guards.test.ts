/**
 * @jest-environment node
 */

/**
 * #677/PM-36 + PM-37 — money-endpoint throttling and dispute-evidence
 * deadline enforcement (source-contract idiom: the routes are thin HTTP
 * shells over mocked services, so we pin the wiring that matters).
 *
 * PM-36 — POST /api/admin/refunds, POST /api/payments/disputes,
 * org invoice create/pdf/pay must run moneyOpsLimiter.
 * PM-37 — evidence submission must reject past-due disputes with a typed
 * 410 BEFORE any gateway push.
 */
import { readFileSync } from "fs";
import path from "path";
import { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
const mockContestDispute = jest.fn();
jest.mock("../../lib/payments/core/razorpay-disputes", () => ({
  ...jest.requireActual("../../lib/payments/core/razorpay-disputes"),
  contestDispute: (...a: unknown[]) => mockContestDispute(...a),
  uploadDisputeDocument: jest.fn(),
}));
const mockDispute = { current: null as Record<string, unknown> | null };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    opsActionLog: { create: async () => ({ id: "ops_1" }) },
    dispute: { findUnique: async () => mockDispute.current },
  },
}));

import { POST } from "../../app/api/payments/disputes/route";

import {
  evidenceDeadlinePassed,
  type EvidenceDeadlineInput,
} from "../../lib/payments/dispute-status";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("PM-36 — moneyOpsLimiter wiring (source contract)", () => {
  const routeFiles = [
    "app/api/payments/disputes/route.ts",
    "app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route.ts",
    "app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts",
  ];

  it.each(routeFiles)("%s applies moneyOpsLimiter", (rel) => {
    const src = read(rel);
    expect(src).toContain("moneyOpsLimiter");
    expect(src).toContain("applyRateLimit(");
    // The limiter import comes from the shared module, not a local copy.
    expect(src).toContain('from "@/lib/rate-limit"');

    // #1236-triage — pay/pdf must key per ACTOR (member id), not orgId:
    // one manager's PDF browsing cannot exhaust a billing admin's bucket.
    const actorKeyed =
      /applyRateLimit\(\s*moneyOpsLimiter,\s*(?:access\.member\?\.id \?\? orgId|actorRateLimitKey)/;
    expect(src).toMatch(
      rel.includes("/pdf/") || rel.includes("/pay/") ? actorKeyed : /^/,
    );
  });

  it("the admin refund door spends the shared money-ops budget", () => {
    expect(read("app/api/admin/refunds/route.ts")).toContain(
      "assertMoneyOpsBudget(actor.userId)",
    );
    expect(read("lib/backoffice/money-limit.ts")).toContain(
      "applyRateLimit(moneyOpsLimiter, userId)",
    );
  });

  it("moneyOpsLimiter exists with the documented budget", () => {
    const src = read("lib/rate-limit.ts");
    expect(src).toMatch(
      /export const moneyOpsLimiter = makeLimiter\(10, "1 m", "rl:money-ops"\)/,
    );
  });
});

describe("PM-37 — evidenceDeadlinePassed guard", () => {
  const base: EvidenceDeadlineInput = {
    status: "NEEDS_RESPONSE",
    dueBy: null,
    nowMs: new Date("2026-08-24T12:00:00Z").getTime(),
  };

  it("passes when no deadline is set", () => {
    expect(evidenceDeadlinePassed(base)).toBe(false);
  });

  it("passes while the deadline is in the future", () => {
    expect(
      evidenceDeadlinePassed({
        ...base,
        dueBy: new Date("2026-08-25T12:00:00Z"),
      }),
    ).toBe(false);
  });

  it("rejects once the deadline has passed", () => {
    expect(
      evidenceDeadlinePassed({
        ...base,
        dueBy: new Date("2026-08-23T12:00:00Z"),
      }),
    ).toBe(true);
  });

  it("terminal disputes are handled by the existing status gate, not this one", () => {
    // WON/LOST never reach the deadline check in the route; the helper stays
    // status-blind so the two guards stay independently testable.
    expect(
      evidenceDeadlinePassed({ ...base, status: "LOST", dueBy: null }),
    ).toBe(false);
  });
});

describe("PM-37 — the evidence door refuses a past-due dispute before any gateway push", () => {
  it("answers 410 EVIDENCE_DEADLINE_PASSED and never calls contestDispute", async () => {
    mockDispute.current = {
      id: "dsp-row-1",
      disputeId: "disp_rzp_1",
      status: "NEEDS_RESPONSE",
      paymentGateway: "RAZORPAY",
      dueBy: new Date(Date.now() - 60_000),
    };

    const res = await POST(
      new NextRequest("https://x.test/api/payments/disputes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          disputeId: "dsp-row-1",
          action: "submit",
          summary: "The session was delivered in full.",
          reason: "contesting the chargeback with proof of delivery",
          evidence: { proof_of_service: ["doc_abc"] },
        }),
      }),
    );

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      code: "EVIDENCE_DEADLINE_PASSED",
    });
    expect(mockContestDispute).not.toHaveBeenCalled();
  });
});
