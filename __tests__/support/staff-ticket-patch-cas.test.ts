/**
 * @jest-environment node
 */

/**
 * The case lifecycle's optimistic concurrency, against the canonical case API.
 *
 * `PATCH /api/support/cases/[caseId]` is the only write door for a case's
 * status, priority and assignee. The pre-cutover staff ticket route is
 * retired (410), so this suite pins the behaviour where it now lives.
 */

const mockUpdateMany = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn(async () => true),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "staff-1", role: "STAFF" } },
  })),
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "user-1", role: "CONSULTEE" } },
  })),
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifySupportTicketUpdate: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  sendSupportTicketUpdateEmail: jest.fn(),
}));
jest.mock("../../lib/prisma", () => {
  const client = {
    supportCase: {
      findUnique: jest.fn(async () => ({
        id: "c1",
        status: "CLOSED",
        resolvedAt: null,
        awaitingUserSince: null,
        deletedAt: null,
        externalRequesterEmail: null,
        ownershipScope: "PERSONAL",
        requesterUserId: "user-1",
        submitterUserId: "user-1",
        organizationId: null,
        caseKind: "INCIDENT",
        priority: "MEDIUM",
        subjects: [],
        messages: [],
        events: [],
      })),
      findUniqueOrThrow: jest.fn(async () => ({
        id: "c1",
        status: "OPEN",
        referenceNumber: "FAM-2026-000001",
        title: "Issue",
        requesterUserId: "user-1",
        submitterUserId: "user-1",
        organizationId: null,
        ownershipScope: "PERSONAL",
        deletedAt: null,
        subjects: [],
        messages: [],
        events: [],
      })),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return {
    __esModule: true,
    default: client,
    ALLOCATION_TX_MAX_WAIT_MS: 1,
    ALLOCATION_TX_TIMEOUT_MS: 1,
  };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { PATCH } from "../../app/api/support/cases/[caseId]/route";
import {
  SupportRequestError,
  isStaleCaseError,
} from "../../lib/support/error-copy";

const patch = (body: object) =>
  PATCH(
    new NextRequest("https://x.test/api/support/cases/c1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId: "c1" }) },
  );

describe("PATCH /api/support/cases/[caseId] CAS", () => {
  beforeEach(() => mockUpdateMany.mockReset().mockResolvedValue({ count: 0 }));

  it("says a closed case's assignee and priority are frozen instead of reporting a conflict", async () => {
    const res = await patch({
      assignedToId: null,
      expectedUpdatedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CASE_CLOSED");
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("CASes on the rendered updatedAt and refuses edits on a case closed meanwhile", async () => {
    (prisma.supportCase.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "c1",
      status: "OPEN",
      resolvedAt: null,
      awaitingUserSince: null,
      deletedAt: null,
      externalRequesterEmail: null,
      ownershipScope: "PERSONAL",
      requesterUserId: "user-1",
      submitterUserId: "user-1",
      organizationId: null,
      caseKind: "INCIDENT",
      priority: "MEDIUM",
      subjects: [],
      messages: [],
      events: [],
    });
    const stamp = "2026-10-01T10:00:00.123Z";
    const res = await patch({ priority: "HIGH", expectedUpdatedAt: stamp });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      id: "c1",
      updatedAt: new Date(stamp),
      status: { not: "CLOSED" },
    });
  });

  it("answers 400 without an expectedUpdatedAt", async () => {
    expect((await patch({ priority: "HIGH" })).status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses ON_HOLD on write with a clear code", async () => {
    const res = await patch({
      status: "ON_HOLD",
      expectedUpdatedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("STATUS_NOT_SUPPORTED");
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("classifies only a 409 as a stale case the panel reloads", () => {
    expect(
      isStaleCaseError(new SupportRequestError("x", 409, "CONFLICT")),
    ).toBe(true);
    expect(
      isStaleCaseError(new SupportRequestError("x", 500, "INTERNAL")),
    ).toBe(false);
  });
});
