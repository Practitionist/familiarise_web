/**
 * @jest-environment node
 */

/** A subscriber CSV export leaves one audit row; the JSON list leaves none. */

const mockCreate = jest.fn(async (_args: unknown) => ({ id: "log-1" }));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { opsActionLog: { create: (args: unknown) => mockCreate(args) } },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "STAFF" } },
  }),
}));

jest.mock("../../lib/newsletter/service", () => ({
  exportSubscribersCsv: async () => "email\n",
  listSubscribers: async () => ({ items: [], total: 0 }),
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/admin/newsletter/route";

const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/admin/newsletter${qs}`));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

it("writes one audit row for a CSV export", async () => {
  const res = await call("?format=csv");
  expect(res.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  const { data } = mockCreate.mock.calls[0][0] as {
    data: Record<string, unknown>;
  };
  expect(data).toMatchObject({
    actorUserId: "op-1",
    surface: "newsletter.manage",
    action: "newsletter.export",
  });
});

it("writes no audit row for the JSON list", async () => {
  const res = await call("?format=json");
  expect(res.status).toBe(200);
  expect(mockCreate).not.toHaveBeenCalled();
});

it("does not return the CSV when the audit write fails", async () => {
  mockCreate.mockRejectedValueOnce(new Error("db down"));
  const res = await call("?format=csv");
  expect(res.status).not.toBe(200);
  expect(res.headers.get("Content-Type")).not.toMatch(/text\/csv/);
});

it("records that a search was applied, never the search text", async () => {
  await call("?format=csv&status=SUBSCRIBED&search=priya%40example.com");
  const { data } = mockCreate.mock.calls[0][0] as {
    data: { after: unknown };
  };
  expect(data.after).toEqual({
    status: "SUBSCRIBED",
    source: null,
    searchApplied: true,
  });
  expect(JSON.stringify(data)).not.toContain("priya");
});
