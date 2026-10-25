/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "../../app/api/health/jobs/route";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "../../lib/cron/operational-health";

jest.mock("../../lib/cron/cleanup-route", () => ({
  bearerMatches: (header: string | null, secret: string) =>
    header === `Bearer ${secret}`,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { systemJobExecution: { groupBy: jest.fn() } },
}));
import prisma from "../../lib/prisma";
const groupBy = jest.mocked(prisma.systemJobExecution.groupBy);
const now = new Date("2026-10-22T12:00:00Z");
const originalEnvironment = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnvironment,
    CRON_SECRET: "test",
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
  };
  jest.useFakeTimers();
  jest.setSystemTime(now);
});
afterEach(() => {
  jest.useRealTimers();
  process.env = originalEnvironment;
});
const request = (secret = "test") =>
  new NextRequest("https://app.test/api/health/jobs", {
    headers: { authorization: `Bearer ${secret}` },
  });
const fresh = () =>
  OPERATIONAL_COMPLETION_REQUIREMENTS.map((job) => ({
    jobName: job.jobName,
    endedAt: now,
  }));

describe("operational absence checks", () => {
  it("requires an actual transfer completion within 45 minutes independently of every other capability", () => {
    const rows = fresh().filter((row) => row.jobName !== "transfer-recordings");
    const report = assessOperationalCompletions(rows, now);
    expect(report.healthy).toBe(false);
    expect(
      report.jobs.find((job) => job.jobName === "transfer-recordings"),
    ).toMatchObject({ overdue: true, maxAgeMinutes: 45 });
  });
  it("one healthy job cannot conceal stopped required capabilities", () => {
    const report = assessOperationalCompletions(
      [{ jobName: "retry-failed-emails", endedAt: now }],
      now,
    );
    expect(report.healthy).toBe(false);
    expect(
      report.jobs.find((j) => j.jobName === "support-sla-sweep")?.overdue,
    ).toBe(true);
  });
  it("uses each completion budget and real completion time", () => {
    const rows = fresh().map((r) =>
      r.jobName === "auto-complete-appointments"
        ? { ...r, endedAt: new Date(now.getTime() - 80 * 60 * 1000) }
        : r,
    );
    expect(assessOperationalCompletions(rows, now).healthy).toBe(true);
    expect(
      assessOperationalCompletions(
        rows,
        new Date(now.getTime() + 46 * 60 * 1000),
      ).healthy,
    ).toBe(false);
  });
  it("refuses unauthorized reads before querying", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    expect(groupBy).not.toHaveBeenCalled();
  });
  it("returns503 for missing completions and counts only completed runs", async () => {
    groupBy.mockResolvedValueOnce([]);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });
  it("does not treat unscoped shared-database history as production evidence", async () => {
    process.env.SENTRY_ENVIRONMENT = "preview";
    groupBy.mockResolvedValueOnce([]);
    await GET(request());
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          result: { path: ["environment"], equals: "production" },
        }),
      }),
    );
  });
  it("uses the server environment when the public environment is absent", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
    process.env.SENTRY_ENVIRONMENT = "development";
    groupBy.mockResolvedValueOnce([]);
    await GET(request());
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          result: { path: ["environment"], equals: "development" },
        }),
      }),
    );
  });
  it.each([undefined, ""])(
    "refuses unconfigured environment %p before querying",
    async (environment) => {
      if (environment === undefined) {
        delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
      } else {
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = environment;
      }
      delete process.env.SENTRY_ENVIRONMENT;
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        healthy: false,
        error: "JOB_ENVIRONMENT_UNCONFIGURED",
      });
      expect(groupBy).not.toHaveBeenCalled();
    },
  );
  it("returns200 only when every required capability completed recently", async () => {
    groupBy.mockResolvedValueOnce(
      fresh().map((r) => ({
        jobName: r.jobName,
        _max: { endedAt: r.endedAt },
      })),
    );
    expect((await GET(request())).status).toBe(200);
  });
  it("history read failure is unavailable, not healthy or never-run", async () => {
    groupBy.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await (await GET(request())).json()).error).toBe(
      "JOB_HISTORY_UNAVAILABLE",
    );
  });
});
