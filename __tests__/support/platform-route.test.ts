/**
 * @jest-environment node
 */

/**
 * #support-hub — PLATFORM intake route wiring (stateless scope).
 *
 * Auth and catalog gating at the boundary: an anonymous caller gets the
 * UNAUTHORIZED envelope; an unknown/stale flowId 404s with refresh guidance
 * instead of silently escalating. The flowchart engine itself is covered by
 * platform-flows/flow-walk suites.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/validation/limits", () => ({
  __esModule: true,
  assertBodySize: jest.fn(() => null),
}));

jest.mock("../../lib/prisma", () => {
  const db = {
    membership: { findMany: jest.fn(async () => []) },
    consultantProfile: { findFirst: jest.fn(async () => null) },
    // Escalation writes a ticket; the counter behind its reference and the
    // staff fan-out both live on the same client.
    supportCase: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async () => ({
        id: "t1",
        title: "T",
        organizationId: null,
        referenceNumber: "FAM-2026-000001",
      })),
    },
    supportCaseCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
    supportFlowOutcome: { create: jest.fn(async () => ({})) },
    user: { findMany: jest.fn(async () => []) },
    organization: { findUnique: jest.fn(async () => null) },
    // Assigned after the literal: referencing `db` inside its own initializer
    // makes TypeScript give up and infer `any`.
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(db) : arg,
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 5000,
    ALLOCATION_TX_TIMEOUT_MS: 15000,
  };
});

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifySupportTicketCreated: jest.fn(async () => ({ success: true })),
  notifySupportTicketActivity: jest.fn(async () => []),
}));

jest.mock("../../lib/support/case-service", () => ({
  appendSupportCaseTurn: jest.fn(async () => ({ ok: true })),
  createOrReuseSupportCase: jest.fn(async () => ({
    supportCase: {
      id: "case-1",
      title: "Help",
      organizationId: null,
      referenceNumber: "FAM-2026-000001",
      ackDueAt: null,
    },
    reused: false,
  })),
}));
import { createOrReuseSupportCase } from "../../lib/support/case-service";
import { NextRequest } from "next/server";
import { getSession } from "../../lib/auth-server";
import prisma from "../../lib/prisma";
import { applyRateLimit, spamLimiter } from "../../lib/rate-limit";
import { GET, POST } from "../../app/api/support/platform/route";

const mockedGetSession = getSession as jest.Mock;

beforeEach(() => {
  (applyRateLimit as jest.Mock).mockClear();
  jest.mocked(createOrReuseSupportCase).mockClear();
  (prisma.supportCase.updateMany as jest.Mock).mockClear();
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/support/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/support/platform", () => {
  it("401 without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(postReq({ flowId: "anything" }));
    expect(res.status).toBe(401);
  });

  it("404 envelope with refresh guidance for an unknown flow (stale catalog)", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    // Bare entry turn — exactly what PlatformSupportSheet.startFlow sends.
    const res = await POST(postReq({ flowId: "no-such-flow" }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NOT_FOUND");
    expect(json.error).toContain("refresh");
  });

  it("REGRESSION: a bare entry turn {flowId} passes validation (the XOR refine used to 400 it)", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(
      postReq({ flowId: "PAYMENTS_BILLING", nodeId: null }),
    );
    // Reaches the engine and answers with the entry prompt — NOT a
    // VALIDATION_FAILED 400.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.escalated).toBe(false);
    expect(json.data.messages.length).toBeGreaterThan(0);
  });

  it("VALIDATION_FAILED envelope when a turn carries BOTH an option and a message", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        chosenOptionId: "twice",
        userMessage: "both",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    // Developer detail: the zod flatten rides along.
    expect(json.detail).toBeDefined();
  });
});

describe("asking for a person, in the scope that had no way to", () => {
  /**
   * The unrecognized-input nudge tells the user to type "agent". The
   * appointment thread honours that through `decideEscalation`; nothing was
   * checking here, so in the platform drawer the instruction dead-ended and the
   * bot simply re-presented itself — a promise the product could not keep.
   */
  it("escalates a free-text message that asks for a human", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    const res = await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "just get me an agent please",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.escalated).toBe(true);
    expect(json.data.supportTicketId).toBeTruthy();
    // Filing the ticket spends the ticket budget; walking the flow does not.
    expect(applyRateLimit).toHaveBeenCalledWith(spamLimiter, "tickets:u1");
  });

  it("files an urgent hand-off at HIGH, not a silent MEDIUM", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "Speak to someone: the refund never arrived",
        urgent: true,
      }),
    );
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "HIGH",
      }),
    );
  });

  it("files the General flow's own human option, sent through the details form, as an urgent general ticket", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    const res = await POST(
      postReq({
        flowId: "GENERAL",
        nodeId: "start",
        userMessage: "Speak to someone: my account page will not load at all",
        urgent: true,
      }),
    );
    const json = await res.json();
    expect(json.data.escalated).toBe(true);
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "HIGH",
        issueType: "GENERAL_INQUIRY",
      }),
    );
  });

  it("raises a reused open ticket to HIGH when the replayed hand-off is urgent", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    (prisma.supportCase.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "t-recent",
      referenceNumber: "FAM-2026-000009",
    });
    const res = await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "Speak to someone: the refund never arrived",
        urgent: true,
      }),
    );
    const json = await res.json();
    expect(json.data.deduped).toBe(true);
    expect(createOrReuseSupportCase).not.toHaveBeenCalled();
    expect(prisma.supportCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: "t-recent",
        closedAt: null,
        deletedAt: null,
        priority: { in: ["LOW", "MEDIUM"] },
      },
      data: { priority: "HIGH" },
    });
  });

  it("leaves a reused ticket's priority alone when the replay is not urgent", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    (prisma.supportCase.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "t-recent",
      referenceNumber: "FAM-2026-000009",
    });
    await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "just get me an agent please",
      }),
    );
    expect(prisma.supportCase.updateMany).not.toHaveBeenCalled();
  });

  it("leaves an ordinary message to the flow", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    const res = await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "where is my money",
      }),
    );
    const json = await res.json();
    expect(json.data.escalated).toBe(false);
    expect(applyRateLimit).not.toHaveBeenCalled();
  });
});

describe("GET /api/support/platform", () => {
  it("401 without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("offers the expert tax flow only to a caller with a live consultant profile", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const ids = async () =>
      ((await (await GET()).json()).data.flows as { id: string }[]).map(
        (f) => f.id,
      );
    expect(await ids()).not.toContain("EXPERT_TAX");

    (prisma.consultantProfile.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "cp1",
    });
    expect(await ids()).toContain("EXPERT_TAX");
    expect(prisma.consultantProfile.findFirst).toHaveBeenLastCalledWith({
      where: { userId: "u1", deletedAt: null },
      select: { id: true },
    });
  });
});

describe("operator billing ownership", () => {
  const dispute = () =>
    POST(
      postReq({
        flowId: "ORG_OPERATOR_BILLING",
        nodeId: "invoice",
        chosenOptionId: "dispute",
        orgId: "org-a",
      }),
    );

  it("files into the org billing queue when the filer holds supportCases.billing.manage", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    (prisma.membership.findMany as jest.Mock).mockResolvedValueOnce([
      { organizationId: "org-a", role: "OWNER" },
    ]);
    const json = await (await dispute()).json();
    expect(json.data.escalated).toBe(true);
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        ownershipScope: "ORG_BILLING",
        issueType: "BILLING_QUESTION",
      }),
    );
  });

  it("lets a BILLING_ADMIN reach the flow and file into the org billing queue", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    (prisma.membership.findMany as jest.Mock).mockResolvedValueOnce([
      { organizationId: "org-a", role: "BILLING_ADMIN" },
    ]);
    const json = await (await dispute()).json();
    expect(json.data.escalated).toBe(true);
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        ownershipScope: "ORG_BILLING",
      }),
    );
  });

  it("keeps the flow from a member with neither operations nor billing access", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    (prisma.membership.findMany as jest.Mock).mockResolvedValueOnce([
      { organizationId: "org-a", role: "LEARNER" },
    ]);
    const res = await dispute();
    expect(res.status).toBe(404);
    expect(createOrReuseSupportCase).not.toHaveBeenCalled();
  });

  it("keeps a MANAGER's escalation personal so they can still see it", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    (prisma.membership.findMany as jest.Mock).mockResolvedValueOnce([
      { organizationId: "org-a", role: "MANAGER" },
    ]);
    await dispute();
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        ownershipScope: "PERSONAL",
      }),
    );
  });

  it("types a wrong org GST invoice as TAX_GST", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    (prisma.membership.findMany as jest.Mock).mockResolvedValueOnce([
      { organizationId: "org-a", role: "OWNER" },
    ]);
    await POST(
      postReq({
        flowId: "ORG_OPERATOR_BILLING",
        nodeId: "invoice",
        chosenOptionId: "gstwrong",
      }),
    );
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        ownershipScope: "ORG_BILLING",
        issueType: "TAX_GST",
      }),
    );
  });
});
