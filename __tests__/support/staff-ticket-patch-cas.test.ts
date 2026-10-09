/**
 * @jest-environment node
 */

const mockUpdateMany = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(async () => ({
    session: { user: { id: "staff-1", role: "STAFF" } },
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
    supportTicket: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        status: "CLOSED",
        resolvedAt: null,
        awaitingUserSince: null,
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
import { PATCH } from "../../app/api/staff/support-tickets/[ticketId]/route";

const patch = (body: object) =>
  PATCH(
    new NextRequest("https://x.test/api/staff/support-tickets/t1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ ticketId: "t1" }) },
  );

describe("PATCH /api/staff/support-tickets/[ticketId] CAS", () => {
  beforeEach(() => mockUpdateMany.mockReset().mockResolvedValue({ count: 0 }));

  it("CASes on the rendered updatedAt and refuses edits on a closed ticket", async () => {
    const stamp = "2026-10-01T10:00:00.123Z";
    const res = await patch({ priority: "HIGH", expectedUpdatedAt: stamp });
    expect(res.status).toBe(409);
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      id: "t1",
      updatedAt: new Date(stamp),
      status: { not: "CLOSED" },
    });
  });

  it("answers 400 without an expectedUpdatedAt", async () => {
    expect((await patch({ priority: "HIGH" })).status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
