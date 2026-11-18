/**
 * @jest-environment node
 */

/** The admin and compliance writes read their body through readJsonBody: junk is 400 MALFORMED_JSON. */
jest.mock("@/lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "u-op", role: "ADMIN" } },
  })),
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "u-1", role: "CONSULTEE" } },
  })),
}));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  spamLimiter: {},
}));
// The maintenance door writes only on the production deploy; this checks the body read after it.
jest.mock("@/lib/production-state", () => ({
  mayWriteProductionState: () => true,
}));
jest.mock("@/lib/cron/with-cron-lock", () => {
  class CronLockHeldError extends Error {}
  class CronLockUnavailableError extends Error {}
  return {
    CronLockHeldError,
    CronLockUnavailableError,
    withCronLock: async (
      _key: string,
      _opts: unknown,
      run: () => Promise<unknown>,
    ) => run(),
  };
});
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/redis", () => ({ __esModule: true, default: {}, redis: {} }));
jest.mock("@/lib/betterstack", () => ({
  createIncident: jest.fn(),
  resolveIncident: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST as reportBreach } from "@/app/api/admin/data-breaches/route";
import { POST as fileGrievance } from "@/app/api/compliance/grievances/route";
import {
  PATCH as updateMaintenance,
  POST as startMaintenance,
} from "@/app/api/admin/maintenance/route";

const junk = (path: string, method: string) =>
  new NextRequest(`http://x${path}`, { method, body: "{not json" });

it.each([
  [
    "POST /api/admin/data-breaches",
    () => reportBreach(junk("/api/admin/data-breaches", "POST")),
  ],
  [
    "POST /api/compliance/grievances",
    () => fileGrievance(junk("/api/compliance/grievances", "POST")),
  ],
  [
    "POST /api/admin/maintenance",
    () => startMaintenance(junk("/api/admin/maintenance", "POST")),
  ],
  [
    "PATCH /api/admin/maintenance",
    () => updateMaintenance(junk("/api/admin/maintenance", "PATCH")),
  ],
])("%s answers 400 MALFORMED_JSON", async (_route, call) => {
  const res = await call();
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("MALFORMED_JSON");
});

it("a data-breach body that parses but is invalid keeps its own 400", async () => {
  const res = await reportBreach(
    new NextRequest("http://x/api/admin/data-breaches", {
      method: "POST",
      body: JSON.stringify({ rootCause: 3 }),
    }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("Invalid body");
});
