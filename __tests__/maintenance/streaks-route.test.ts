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
import {
  isRepeatedFailure,
  streakReportSchema,
} from "../../lib/cron/failure-streak";

const originalEnv = { ...process.env };

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
  jest.resetAllMocks();
  process.env.CRON_SECRET = "s3cret";
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
  delete process.env.SENTRY_ENVIRONMENT;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/health/jobs/streaks", () => {
  it("requires the bearer secret", async () => {
    expect((await call("abandoned-payments")).status).toBe(401);
    expect((await call("abandoned-payments", "Bearer nope")).status).toBe(401);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])(
    "refuses unconfigured history instead of combining environments (%s)",
    async (environment) => {
      if (environment === undefined) {
        delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
      } else {
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = environment;
      }
      const res = await call("abandoned-payments", "Bearer s3cret");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "JOB_ENVIRONMENT_UNCONFIGURED",
      });
      expect(groupBy).not.toHaveBeenCalled();
    },
  );

  it("uses the server environment when the public label is absent", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
    process.env.SENTRY_ENVIRONMENT = "production";
    groupBy.mockResolvedValue([]);
    expect((await call("abandoned-payments", "Bearer s3cret")).status).toBe(
      200,
    );
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          result: { path: ["environment"], equals: "production" },
        }),
      }),
    );
  });

  it("does not let a dev completion mask repeated production failures", async () => {
    const now = new Date();
    const history = [
      {
        environment: "dev",
        jobName: "cleanup-abandoned-payments",
        status: "COMPLETED",
        _max: { startedAt: now },
      },
      {
        environment: "production",
        jobName: "cleanup-abandoned-payments",
        status: "FAILED",
        _max: { startedAt: now },
      },
    ];
    groupBy.mockImplementation(
      (query: { where: { result?: { equals: string } } }) =>
        Promise.resolve(
          history.filter(
            (row) =>
              !query.where.result ||
              row.environment === query.where.result.equals,
          ),
        ),
    );
    const res = await call("abandoned-payments", "Bearer s3cret");
    const report = streakReportSchema.parse(await res.json());
    expect(report["abandoned-payments"]).toEqual({
      lastCompletedAt: null,
      seenRecently: true,
    });
    expect(isRepeatedFailure(15, report["abandoned-payments"], now)).toBe(true);
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
    expect(groupBy.mock.calls[0][0].where.result).toEqual({
      path: ["environment"],
      equals: "production",
    });
    expect(body).toEqual({
      "abandoned-payments": {
        lastCompletedAt: started.toISOString(),
        seenRecently: true,
      },
    });
  });
});
