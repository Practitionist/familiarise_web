/** @jest-environment node */

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: { id: "spam" },
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/support/case-service", () => ({
  ...jest.requireActual("../../lib/support/case-service"),
  createOrReuseSupportCase: jest.fn(async () => ({
    supportCase: { id: "case-1" },
    reused: false,
    dedupeReason: null,
  })),
  readSupportCaseForViewer: jest.fn(async () => ({ id: "case-1" })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findFirst: jest.fn(), findMany: jest.fn(async () => []) },
    appointment: { findUnique: jest.fn() },
    payment: { findFirst: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { requireApiAuth } from "../../lib/auth-helpers";
import { applyRateLimit } from "../../lib/rate-limit";
import { createOrReuseSupportCase } from "../../lib/support/case-service";
import { POST } from "../../app/api/support/cases/route";

const db = prisma as unknown as {
  membership: { findFirst: jest.Mock };
  appointment: { findUnique: jest.Mock };
};

const signIn = (id: string, role = "CONSULTEE") =>
  jest
    .mocked(requireApiAuth)
    .mockResolvedValue({ session: { user: { id, role } } } as never);

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("https://test/api/support/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Session problem",
        description: "The session did not happen",
        category: "NO_SHOW",
        ...body,
      }),
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  db.membership.findFirst.mockImplementation(
    async ({ where }: { where: { userId: string } }) =>
      where.userId === "operator"
        ? { id: "m-op", role: "OWNER" }
        : { id: "m-member", role: "LEARNER" },
  );
});

describe("filing a case on behalf of an organization member", () => {
  it("refuses a member's private booking that the organization does not own", async () => {
    signIn("operator");
    db.appointment.findUnique.mockResolvedValue({
      id: "appt-private",
      organizationId: null,
      participants: [{ userId: "member", organizationId: null }],
      payment: [{ userId: "member" }],
    });

    const response = await post({
      requesterUserId: "member",
      organizationId: "org-1",
      appointmentId: "appt-private",
    });

    expect(response.status).toBe(403);
    expect(createOrReuseSupportCase).not.toHaveBeenCalled();
  });

  it("files an organization booking as an organization-owned case", async () => {
    signIn("operator");
    db.appointment.findUnique.mockResolvedValue({
      id: "appt-org",
      organizationId: "org-1",
      participants: [{ userId: "member", organizationId: "org-1" }],
      payment: [],
    });

    const response = await post({
      requesterUserId: "member",
      organizationId: "org-1",
      appointmentId: "appt-org",
    });

    expect(response.status).toBe(201);
    expect(createOrReuseSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        ownershipScope: "ORG_OPERATIONS",
        requesterUserId: "member",
        submitterUserId: "operator",
      }),
    );
  });
});

describe("intake validation and limits", () => {
  it("rejects a free-text category from a client", async () => {
    signIn("member");
    const response = await post({ category: "Anything I like" });
    expect(response.status).toBe(400);
    expect(createOrReuseSupportCase).not.toHaveBeenCalled();
  });

  it("does not spend the hourly spam budget of an operator who manages tickets", async () => {
    signIn("staff-1", "STAFF");
    await post({ requesterUserId: "member" });
    expect(applyRateLimit).not.toHaveBeenCalled();
  });

  it("keeps the spam budget for customers", async () => {
    signIn("member");
    await post({});
    expect(applyRateLimit).toHaveBeenCalledWith(
      { id: "spam" },
      "support-cases:member",
    );
  });
});
