/**
 * @jest-environment node
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  assessMissedWindow,
  buildJobRunMetrics,
  istDayKeys,
  scheduleForJob,
} from "@/lib/backoffice/job-run-metrics";

const now = new Date("2026-10-26T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("missed window", () => {
  it("uses the completion SLO when the job has one", () => {
    const check = (last: Date | null) =>
      assessMissedWindow({
        jobName: "reconcile-payment-status",
        lastSuccessAt: last,
        now,
      });
    expect(check(ago(30))).toEqual({ state: "ok", basis: "slo" });
    expect(check(ago(50))).toEqual({ state: "missed", basis: "slo" });
    expect(check(null)).toEqual({ state: "missed", basis: "slo" });
  });

  it("allows two ticker slots plus a tick, matching a prefixed lock name", () => {
    expect(scheduleForJob("cleanup-abandoned-payments")?.name).toBe(
      "abandoned-payments",
    );
    const check = (minutes: number) =>
      assessMissedWindow({
        jobName: "cleanup-abandoned-payments",
        lastSuccessAt: ago(minutes),
        now,
      }).state;
    expect(check(34)).toBe("ok");
    expect(check(36)).toBe("missed");
  });

  it("checks a calendar job against its latest due window", () => {
    // Monday 2026-10-26 20:00 UTC opens the payout batch window.
    const batch = (last: Date, at: Date) =>
      assessMissedWindow({
        jobName: "create-payout-batch",
        lastSuccessAt: last,
        now: at,
      }).state;
    const beforeOpen = new Date("2026-10-26T19:00:00Z");
    expect(batch(new Date("2026-10-19T20:10:00Z"), beforeOpen)).toBe("ok");
    const afterOpen = new Date("2026-10-26T21:00:00Z");
    expect(batch(new Date("2026-10-19T20:10:00Z"), afterOpen)).toBe("missed");
    expect(batch(new Date("2026-10-26T20:10:00Z"), afterOpen)).toBe("ok");
  });

  it("maps an overridden execution name and stops judging a window older than the trail", () => {
    expect(scheduleForJob("tds-26q-draft-export")?.name).toBe(
      "tds-return-draft",
    );
    const tds = (at: string) =>
      assessMissedWindow({
        jobName: "tds-26q-draft-export",
        lastSuccessAt: null,
        now: new Date(at),
      }).state;
    // The Jul 5 window is 91 days old, past the 90-day trail; Oct 5 has opened.
    expect(tds("2026-10-04T12:00:00Z")).toBe("ok");
    expect(tds("2026-10-05T04:00:00Z")).toBe("missed");
  });

  it("leaves a job with no SLO and no ticker cadence unscheduled", () => {
    expect(
      assessMissedWindow({
        jobName: "prune-audit-logs",
        lastSuccessAt: null,
        now,
      }),
    ).toEqual({ state: "unscheduled", basis: null });
  });
});

it("folds counts, rounds percentiles, fills IST days and sorts missed jobs first", () => {
  const metrics = buildJobRunMetrics({
    now,
    environment: "production",
    counts: [
      {
        jobName: "prune-audit-logs",
        status: "COMPLETED",
        count: 3,
        itemsProcessed: 9,
      },
      {
        jobName: "prune-audit-logs",
        status: "FAILED",
        count: 1,
        itemsProcessed: 0,
      },
      {
        jobName: "prune-audit-logs",
        status: "CANCELLED",
        count: 2,
        itemsProcessed: 0,
      },
    ],
    percentiles: [{ jobName: "prune-audit-logs", p50: 1234.4, p95: 9876.6 }],
    daily: [
      { jobName: "prune-audit-logs", day: "2026-10-26", runs: 6, failures: 1 },
    ],
    lastSuccess: [],
  });
  const prune = metrics.jobs.find((j) => j.jobName === "prune-audit-logs");
  expect(prune).toMatchObject({
    runs: 6,
    succeeded: 3,
    failed: 1,
    held: 2,
    p50Ms: 1234,
    p95Ms: 9877,
    itemsProcessed: 9,
  });
  expect(metrics.days).toEqual(istDayKeys(now));
  expect(metrics.days).toHaveLength(7);
  expect(prune?.daily.at(-1)).toEqual({
    day: "2026-10-26",
    runs: 6,
    failures: 1,
  });
  expect(prune?.daily[0]).toEqual({ day: "2026-10-20", runs: 0, failures: 0 });
  // SLO jobs with no run at all still appear, flagged, ahead of the rest.
  expect(metrics.jobs[0].missed.state).toBe("missed");
  expect(metrics.jobs.at(-1)?.jobName).toBe("prune-audit-logs");
});

it("reports no-runs instead of missed when a non-production deployment has no success of its own", () => {
  const input = {
    now,
    counts: [
      {
        jobName: "prune-audit-logs",
        status: "COMPLETED" as const,
        count: 1,
        itemsProcessed: 0,
      },
    ],
    percentiles: [],
    daily: [],
    lastSuccess: [],
  };
  const preview = buildJobRunMetrics({ ...input, environment: "preview" });
  expect(
    preview.jobs.find((j) => j.jobName === "prune-audit-logs")?.missed,
  ).toEqual({ state: "no-runs", basis: null });
  const production = buildJobRunMetrics({
    ...input,
    environment: "production",
  });
  expect(
    production.jobs.find((j) => j.jobName === "prune-audit-logs")?.missed.state,
  ).not.toBe("no-runs");
});

it("keeps a stopped ticker job with no run in 7 days on the table as missed", () => {
  const metrics = buildJobRunMetrics({
    now,
    environment: "production",
    counts: [],
    percentiles: [],
    daily: [],
    lastSuccess: [
      { jobName: "cleanup-abandoned-payments", endedAt: ago(9 * 24 * 60) },
    ],
  });
  const names = metrics.jobs.map((j) => j.jobName);
  expect(names).toContain("cleanup-abandoned-payments");
  expect(names).toContain("tds-26q-draft-export");
  expect(names).not.toContain("tds-return-draft");
  expect(
    metrics.jobs.find((j) => j.jobName === "cleanup-abandoned-payments")
      ?.missed,
  ).toEqual({ state: "missed", basis: "interval" });
});
