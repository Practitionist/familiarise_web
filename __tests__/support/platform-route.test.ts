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
 *
 * An escalation now files a canonical SupportCase (through
 * createOrReuseSupportCase), so the row the queue will show is written by
 * `supportCase.create`, and a replayed hand-off raises THAT case instead of
 * filing a second one.
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
    // Escalation writes a canonical case; the counter behind its reference and
    // the staff fan-out all live on the same client.
    supportCase: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(
        async (args: {
          data: Record<string, unknown> & {
            title: string;
            description: string;
            requesterUserId: string;
            submitterUserId: string;
            priority: string;
            organizationId: string | null;
            issueType: string | null;
            category: string | null;
            ackDueAt: Date;
            referenceNumber: string;
          };
        }) => ({
          id: "c1",
          status: "OPEN",
          activeChannel: "HUMAN",
          createdAt: new Date("2026-03-01T00:00:00Z"),
          ...args.data,
        }),
      ),
    },
    supportTicketCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
    supportFlowOutcome: { create: jest.fn(async () => ({ id: "o1" })) },
    user: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
    },
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
  notifySupportTicketResponse: jest.fn(async () => ({ staged: null })),
}));

jest.mock("../../lib/novu/stage-bell", () => ({
  __esModule: true,
  stageBell: jest.fn(async () => null),
}));

jest.mock("../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

jest.mock("../../lib/email/senders/people", () => ({
  __esModule: true,
  sendSupportTicketReceivedEmail: jest.fn(async () => undefined),
}));

import { NextRequest } from "next/server";
import { getSession } from "../../lib/auth-server";
import prisma from "../../lib/prisma";
import { applyRateLimit, spamLimiter } from "../../lib/rate-limit";
import { GET, POST } from "../../app/api/support/platform/route";

const mockedGetSession = getSession as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (applyRateLimit as jest.Mock).mockClear();
  (prisma.supportCase.create as jest.Mock).mockClear();
  (prisma.supportCase.updateMany as jest.Mock).mockClear();
  // Reset the two reads whose value a test queues per-scenario, so a queued
  // "recent case" never leaks into the next test.
  const findFirst = prisma.supportCase.findFirst as jest.Mock;
  findFirst.mockReset();
  findFirst.mockResolvedValue(null);
  const findUnique = prisma.supportCase.findUnique as jest.Mock;
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/support/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/support/platform", () => {
  it("401 UNAUTHORIZED envelope without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(postReq({ flowId: "anything" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
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
    expect(prisma.supportCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: "HIGH" }),
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
    expect(prisma.supportCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priority: "HIGH",
          issueType: "GENERAL_INQUIRY",
        }),
      }),
    );
  });

  it("raises a reused open case to HIGH when the replayed hand-off is urgent", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    (prisma.supportCase.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "c-recent",
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
    expect(json.data.supportTicketId).toBe("c-recent");
    expect(prisma.supportCase.create).not.toHaveBeenCalled();
    expect(prisma.supportCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: "c-recent",
        closedAt: null,
        deletedAt: null,
        priority: { in: ["LOW", "MEDIUM"] },
      },
      data: { priority: "HIGH" },
    });
  });

  it("leaves a reused case's priority alone when the replay is not urgent", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    (prisma.supportCase.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "c-recent",
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
  it("401 UNAUTHORIZED envelope without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });
});
