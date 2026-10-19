/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "viewer", role: "CONSULTEE" } },
  })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: { findMany: jest.fn(), count: jest.fn(async () => 1) },
    moderationAction: { findMany: jest.fn(), count: jest.fn(async () => 1) },
  },
}));
import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { GET } from "../../app/api/user/reports/route";
const reports = prisma.moderationReport.findMany as jest.Mock;
const actions = prisma.moderationAction.findMany as jest.Mock;
const get = (query = "") =>
  GET(new NextRequest(`https://test/api/user/reports${query}`));
beforeEach(() => {
  jest.clearAllMocks();
  reports.mockResolvedValue([
    {
      id: "report-1",
      type: "REVIEW",
      status: "ACTION_TAKEN",
      createdAt: new Date("2026-01-01"),
      resolvedAt: new Date("2026-01-02"),
      actions: [
        {
          id: "action-1",
          createdAt: new Date("2026-01-02"),
          actionType: "CONTENT_REMOVED",
        },
      ],
      description: "private statement",
      contentText: "private evidence",
      reportedById: "private-reporter",
    },
  ]);
  actions.mockResolvedValue([
    {
      id: "action-direct",
      reportId: null,
      actionType: "REVIEW_REMOVED",
      createdAt: new Date("2026-01-02"),
    },
  ]);
});
it("returns personal report receipts without private evidence or another reporter identity", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(reports.mock.calls[0][0].where).toEqual({ reportedById: "viewer" });
  const report = (await response.json()).reports[0];
  expect(report).toMatchObject({
    outcome: "CONTENT_REMOVED",
    moderationActionId: "action-1",
  });
  expect(report).not.toHaveProperty("description");
  expect(report).not.toHaveProperty("contentText");
  expect(report).not.toHaveProperty("reportedById");
});
it("includes direct moderation decisions with a real appeal action identity", async () => {
  const response = await get("?scope=decisions");
  const body = await response.json();
  expect(actions.mock.calls[0][0].where.OR).toEqual(
    expect.arrayContaining([{ report: { targetUserId: "viewer" } }]),
  );
  expect(body.reports[0]).toMatchObject({
    moderationActionId: "action-direct",
    appealUntil: "2026-07-02T00:00:00.000Z",
  });
  expect(actions.mock.calls[0][0].select).not.toHaveProperty("notes");
  expect(reports).not.toHaveBeenCalled();
});
it("keeps escalated reports pending", async () => {
  reports.mockResolvedValueOnce([
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
it("rejects an unknown scope without reading either queue", async () => {
  expect((await get("?scope=all")).status).toBe(400);
  expect(reports).not.toHaveBeenCalled();
  expect(actions).not.toHaveBeenCalled();
});
