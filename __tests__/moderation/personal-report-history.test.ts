/** @jest-environment node */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "viewer" } })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: { findMany: jest.fn(), count: jest.fn(async () => 1) },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { GET } from "../../app/api/user/reports/route";

const findMany = prisma.moderationReport.findMany as jest.Mock;
const get = (query = "") =>
  GET(new NextRequest(`https://test/api/user/reports${query}`));

beforeEach(() => {
  jest.clearAllMocks();
  findMany.mockResolvedValue([
    {
      id: "report-owned-by-viewer",
      type: "REVIEW",
      status: "ACTION_TAKEN",
      createdAt: new Date(),
      resolvedAt: new Date(),
      actions: [{ actionType: "CONTENT_REMOVED" }],
      reportedById: "private-reporter",
      targetUserId: "private-target",
      description: "private statement",
      contentText: "private evidence",
    },
  ]);
});

it("returns a reporter's own rows and safe outcome without private evidence or participant identities", async () => {
  const response = await get();
  expect(findMany.mock.calls[0][0].where).toEqual({ reportedById: "viewer" });
  expect(
    (prisma.moderationReport.count as jest.Mock).mock.calls[0][0].where,
  ).toEqual({ reportedById: "viewer" });
  const report = (await response.json()).reports[0];
  expect(report).toMatchObject({
    reference: expect.stringMatching(/^RPT-/),
    outcome: "CONTENT_REMOVED",
  });
  expect(report).not.toHaveProperty("reportedById");
  expect(report).not.toHaveProperty("targetUserId");
  expect(report).not.toHaveProperty("description");
  expect(report).not.toHaveProperty("contentText");
});

it("shows affected users terminal decisions only, without revealing pending reports", async () => {
  const response = await get("?scope=decisions");
  expect(response.status).toBe(200);
  expect(findMany.mock.calls[0][0].where).toEqual({
    targetUserId: "viewer",
    status: "ACTION_TAKEN",
  });
  expect(findMany.mock.calls[0][0].select).not.toHaveProperty("reportedBy");
  expect(findMany.mock.calls[0][0].select.actions.select).toEqual({
    actionType: true,
  });
});

it("keeps escalated reports pending in the public outcome", async () => {
  findMany.mockResolvedValueOnce([
    {
      id: "escalated",
      type: "MESSAGE",
      status: "ESCALATED",
      createdAt: new Date(),
      resolvedAt: null,
      actions: [],
    },
  ]);
  expect((await (await get()).json()).reports[0].outcome).toBe(
    "PENDING_REVIEW",
  );
});

it("rejects unknown scopes instead of exposing another user's history", async () => {
  expect((await get("?scope=all")).status).toBe(400);
  expect(findMany).not.toHaveBeenCalled();
});
