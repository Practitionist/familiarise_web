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
import { POST as createTopics } from "@/app/api/user/content/topics/route";

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
