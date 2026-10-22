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

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test";
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
  jest.useFakeTimers();
  jest.setSystemTime(now);
});
afterEach(() => jest.useRealTimers());
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
  it("one healthy job cannot conceal stopped required capabilities", () => {
    const report = assessOperationalCompletions(
      [{ jobName: "retry-failed-emails", endedAt: now }],
      now,
    );
    expect(report.healthy).toBe(false);
    expect(
      report.jobs.find((j) => j.jobName === "transfer-recordings")?.overdue,
    ).toBe(true);
  });
  it("uses each completion budget and real completion time", () => {
    const rows = fresh().map((r) =>
      r.jobName === "transfer-recordings"
        ? { ...r, endedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000) }
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
