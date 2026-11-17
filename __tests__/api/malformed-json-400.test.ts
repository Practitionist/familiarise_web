/**
 * @jest-environment node
 */

/** Junk JSON is the caller's mistake: a 400 MALFORMED_JSON, never a 500. */
jest.mock("@/lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "u-1" } })),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
const reportSentryError = jest.fn();
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
}));

import { NextRequest } from "next/server";
import { DELETE as deletePlanImage } from "@/app/api/plans/image/route";
import {
  DELETE as deleteTopics,
  POST as createTopics,
} from "@/app/api/user/content/topics/route";

const junk = (path: string, method: string) =>
  new NextRequest(`http://x${path}`, { method, body: "{not json" });

it.each([
  [
    "DELETE /api/plans/image",
    () => deletePlanImage(junk("/api/plans/image", "DELETE")),
  ],
  [
    "POST /api/user/content/topics",
    () => createTopics(junk("/api/user/content/topics", "POST")),
  ],
])("%s answers 400 MALFORMED_JSON", async (_route, call) => {
  const res = await call();
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("MALFORMED_JSON");
  expect(reportSentryError).not.toHaveBeenCalled();
});

it.each([
  ["POST", createTopics, "Topics array is required"],
  ["DELETE", deleteTopics, "Topic IDs array is required"],
] as const)(
  "%s /api/user/content/topics with a JSON null body answers 400",
  async (method, handler, error) => {
    const res = await handler(
      new NextRequest("http://x/api/user/content/topics", {
        method,
        body: "null",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(reportSentryError).not.toHaveBeenCalled();
  },
);
