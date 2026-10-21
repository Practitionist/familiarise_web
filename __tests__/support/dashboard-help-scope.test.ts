/** @jest-environment node */
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "viewer" } },
  })),
  requireOrgAccess: jest.fn(async () => ({
    member: { status: "ACTIVE", role: "OWNER" },
  })),
}));
jest.mock("../../lib/support/case-actions", () => ({
  evidenceRecipientsByAppointment: jest.fn(
    async (_db: unknown, ids: string[]) =>
      new Map(ids.map((id) => [id, [{ id: "viewer", name: "Expert" }]])),
  ),
}));
jest.mock("../../lib/support/case-access", () => ({
  ...jest.requireActual("../../lib/support/case-access"),
  visibleCaseAccess: jest.fn(async () => ({
    where: { deletedAt: null, submitterUserId: "viewer" },
    canCorrespond: () => true,
  })),
}));
jest.mock("../../lib/support/case-read", () => ({
  PLAN_TITLE_SELECT: {},
  planTitle: jest.fn(() => "Session"),
}));
jest.mock("../../lib/api/support-http", () => ({
  supportError: ({ status }: { status: number }) =>
    new Response(JSON.stringify({ error: "Invalid request" }), { status }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCaseEvidenceRequest: {
      findMany: jest.fn(async () => [
        {
          id: "evidence-1",
          prompt: "Attendance timeline",
          dueAt: new Date("2026-10-22T12:00:00Z"),
          respondedAt: null,
          cancelledAt: null,
          supportCase: { appointmentId: "appointment-1" },
        },
      ]),
    },
    supportCase: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 42),
    },
    $transaction: jest.fn(async (fn: (tx: object) => Promise<unknown>) =>
      fn({}),
    ),
  },
}));

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { evidenceRecipientsByAppointment } from "@/lib/support/case-actions";
import { GET as evidenceList } from "@/app/api/support/evidence/route";
import { GET as requestList } from "@/app/api/support/requests/route";

beforeEach(() => jest.clearAllMocks());

it("keeps organization evidence recipient-only and matches sponsor or delivery host", async () => {
  const response = await evidenceList(
    new NextRequest(
      "https://example.test/api/support/evidence?organizationId=org-1",
    ),
  );
  expect(response.status).toBe(200);
  expect(requireOrgAccess).toHaveBeenCalledWith("org-1", { readOnly: true });
  expect(prisma.supportCaseEvidenceRequest.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        recipientUserId: "viewer",
        supportCase: {
          deletedAt: null,
          appointment: {
            OR: [
              { organizationId: "org-1" },
              { payment: { some: { hostOrganizationId: "org-1" } } },
            ],
          },
        },
      },
    }),
  );
  expect(await response.json()).toEqual({
    data: [expect.objectContaining({ id: "evidence-1" })],
  });
});

it("refuses organization evidence before reading requests when membership access is denied", async () => {
  jest.mocked(requireOrgAccess).mockResolvedValueOnce({
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  });
  const response = await evidenceList(
    new NextRequest(
      "https://example.test/api/support/evidence?organizationId=org-1",
    ),
  );
  expect(response.status).toBe(403);
  expect(prisma.supportCaseEvidenceRequest.findMany).not.toHaveBeenCalled();
});

it("hides an evidence request when the recipient no longer delivers the session", async () => {
  jest
    .mocked(evidenceRecipientsByAppointment)
    .mockResolvedValueOnce(new Map([["appointment-1", []]]));
  const response = await evidenceList(
    new NextRequest("https://example.test/api/support/evidence"),
  );
  expect(await response.json()).toEqual({ data: [] });
});

it("paginates the personal inbox: personal cases plus org cases filed about the viewer", async () => {
  const response = await requestList(
    new NextRequest(
      "https://example.test/api/support/requests?ownership=personal&scope=session&status=OPEN&page=2",
    ),
  );
  expect(response.status).toBe(200);
  const where = {
    AND: [
      { deletedAt: null, submitterUserId: "viewer" },
      {
        OR: [
          { ownershipScope: "PERSONAL" },
          { requesterUserId: "viewer", NOT: { submitterUserId: "viewer" } },
        ],
      },
      { status: "OPEN" },
      { appointmentId: { not: null } },
    ],
  };
  expect(prisma.supportCase.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where, take: 20, skip: 20 }),
  );
  expect(prisma.supportCase.count).toHaveBeenCalledWith({ where });
  expect(await response.json()).toEqual({
    data: [],
    pagination: { page: 2, pageSize: 20, total: 42 },
  });
});

it("rejects an unknown status instead of silently showing a different inbox", async () => {
  const response = await requestList(
    new NextRequest(
      "https://example.test/api/support/requests?status=WAIT_FOREVER",
    ),
  );
  expect(response.status).toBe(400);
  expect(prisma.supportCase.findMany).not.toHaveBeenCalled();
});
