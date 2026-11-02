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
  it("uses the job's freshness budget derived from its schedule", () => {
    const check = (last: Date | null) =>
      assessMissedWindow({
        jobName: "reconcile-payment-status",
        lastSuccessAt: last,
        now,
      });
    expect(check(ago(59))).toEqual({ state: "ok", basis: "slo" });
    expect(check(ago(61))).toEqual({ state: "missed", basis: "slo" });
    expect(check(null)).toEqual({ state: "missed", basis: "slo" });
  });

  it("judges a prefixed lock name by its target's budget", () => {
    expect(scheduleForJob("cleanup-abandoned-payments")?.name).toBe(
      "abandoned-payments",
    );
    const check = (minutes: number) =>
      assessMissedWindow({
        jobName: "cleanup-abandoned-payments",
        lastSuccessAt: ago(minutes),
        now,
      }).state;
    expect(check(59)).toBe("ok");
    expect(check(61)).toBe("missed");
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

  it("maps an overridden execution name and judges its quarterly window", () => {
    expect(scheduleForJob("tds-26q-draft-export")?.name).toBe(
      "tds-return-draft",
    );
    const tds = (at: string) =>
      assessMissedWindow({
        jobName: "tds-26q-draft-export",
        lastSuccessAt: new Date("2026-07-05T02:55:00Z"),
        now: new Date(at),
      });
    // The Jul 5 run is inside its 92-day budget until the Oct 5 window opens.
    expect(tds("2026-10-04T12:00:00Z")).toEqual({ state: "ok", basis: "slo" });
    expect(tds("2026-10-05T04:00:00Z")).toEqual({
      state: "missed",
      basis: "window",
    });
  });

  it("leaves a job with no SLO and no ticker cadence unscheduled", () => {
    expect(
      assessMissedWindow({
        jobName: "retired-sweep",
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
        jobName: "retired-sweep",
        status: "COMPLETED",
        outcome: "completed",
        count: 2,
        itemsProcessed: 9,
      },
      {
        jobName: "retired-sweep",
        status: "COMPLETED",
        outcome: "attention",
        count: 1,
        itemsProcessed: 0,
      },
      {
        jobName: "retired-sweep",
        status: "FAILED",
        outcome: "failed",
        count: 1,
        itemsProcessed: 0,
      },
      {
        jobName: "retired-sweep",
        status: "FAILED",
        outcome: "partial",
        count: 2,
        itemsProcessed: 4,
      },
      {
        jobName: "retired-sweep",
        status: "CANCELLED",
        outcome: "held",
        count: 2,
        itemsProcessed: 0,
      },
      {
        jobName: "retired-sweep",
        status: "CANCELLED",
        outcome: "refused",
        count: 1,
        itemsProcessed: 0,
      },
    ],
    percentiles: [{ jobName: "retired-sweep", p50: 1234.4, p95: 9876.6 }],
    daily: [
      { jobName: "retired-sweep", day: "2026-10-26", runs: 6, failures: 1 },
    ],
    lastSuccess: [],
  });
  const prune = metrics.jobs.find((j) => j.jobName === "retired-sweep");
  expect(prune).toMatchObject({
    runs: 9,
    succeeded: 3,
    attention: 1,
    partial: 2,
    failed: 1,
    held: 2,
    skipped: 1,
    p50Ms: 1234,
    p95Ms: 9877,
    itemsProcessed: 13,
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
  expect(metrics.jobs.at(-1)?.jobName).toBe("retired-sweep");
});

it("reports no-runs instead of missed when a non-production deployment has no success of its own", () => {
  const input = {
    now,
    counts: [
      {
        jobName: "retired-sweep",
        status: "COMPLETED" as const,
        outcome: "completed",
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
    preview.jobs.find((j) => j.jobName === "retired-sweep")?.missed,
  ).toEqual({ state: "no-runs", basis: null });
  const production = buildJobRunMetrics({
    ...input,
    environment: "production",
  });
  expect(
    production.jobs.find((j) => j.jobName === "retired-sweep")?.missed.state,
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
  ).toEqual({ state: "missed", basis: "slo" });
});

it("counts a recent idle skip as a healthy no-work tick", () => {
  const job = buildJobRunMetrics({
    now,
    environment: "production",
    counts: [],
    percentiles: [],
    daily: [],
    lastSuccess: [
      { jobName: "cleanup-abandoned-payments", endedAt: ago(9 * 24 * 60) },
    ],
    idle: [
      { jobName: "cleanup-abandoned-payments", endedAt: ago(10), skips: 96 },
    ],
  }).jobs.find((j) => j.jobName === "cleanup-abandoned-payments");
  expect(job?.missed).toEqual({ state: "ok", basis: "slo" });
  expect(job?.idleSkips).toBe(96);
  expect(job?.lastSuccessAt).toBe(ago(10).toISOString());
});
