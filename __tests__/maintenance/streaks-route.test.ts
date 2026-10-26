/**
 * @jest-environment node
 */
const groupBy = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: { groupBy: (...a: unknown[]) => groupBy(...a) },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/health/jobs/streaks/route";

const call = (targets: string, auth?: string) =>
  GET(
    new NextRequest(
      `https://x.test/api/health/jobs/streaks?targets=${targets}`,
      {
        headers: auth ? { authorization: auth } : {},
      },
    ),
  );

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
});

describe("GET /api/health/jobs/streaks", () => {
  it("requires the bearer secret", async () => {
    expect((await call("abandoned-payments")).status).toBe(401);
    expect((await call("abandoned-payments", "Bearer nope")).status).toBe(401);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("resolves target names to job names and returns the last COMPLETED start", async () => {
    const started = new Date("2026-10-27T10:00:00Z");
    groupBy.mockResolvedValue([
      {
        jobName: "cleanup-abandoned-payments",
        status: "COMPLETED",
        _max: { startedAt: started },
      },
      {
        jobName: "cleanup-abandoned-payments",
        status: "FAILED",
        _max: { startedAt: new Date() },
      },
    ]);
    const res = await call(
      "abandoned-payments,sentry-ingest-canary,not-a-target",
      "Bearer s3cret",
    );
    const body = await res.json();
    expect(groupBy.mock.calls[0][0].where.jobName).toEqual({
      in: ["cleanup-abandoned-payments"],
    });
    expect(body).toEqual({
      "abandoned-payments": {
        lastCompletedAt: started.toISOString(),
        seenRecently: true,
      },
    });
  });
});
