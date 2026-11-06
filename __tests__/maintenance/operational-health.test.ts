/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "../../app/api/health/jobs/route";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "../../lib/cron/operational-health";
import { checkJobCoverage } from "../../lib/cron/job-coverage";
import {
  unknownReleaseLag,
  type ReleaseLag,
} from "../../lib/observability/release-lag";
import {
  dueTargets,
  maxSlotGapMinutes,
  TARGETS,
  type Target,
} from "../../lib/cron/schedule";

jest.mock("../../lib/cron/cleanup-route", () => ({
  bearerMatches: (header: string | null, secret: string) =>
    header === `Bearer ${secret}`,
}));
const mockFindFirst = jest.fn<Promise<unknown>, unknown[]>(async () => null);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: {
      groupBy: jest.fn(),
      findMany: jest.fn(async () => []),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
    $queryRaw: jest.fn(async () => []),
  },
}));
import prisma from "../../lib/prisma";
const groupBy = jest.mocked(prisma.systemJobExecution.groupBy);
const queryRaw = jest.mocked(prisma.$queryRaw);
const now = new Date("2026-10-22T12:00:00Z");
const MINUTE_MS = 60_000;
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
const paging = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
  (job) => job.tier === "paging",
);
const requirementFor = (target: Target) =>
  OPERATIONAL_COMPLETION_REQUIREMENTS.find((job) => job.target === target)!;
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * MINUTE_MS);
/** Every paging job's newest run, one minute inside its budget unless overridden. */
const groupRows = (overrides: Record<string, Date> = {}) =>
  paging.map((job) => ({
    jobName: job.jobName,
    status: "COMPLETED",
    _max: {
      endedAt: overrides[job.jobName] ?? minutesAgo(job.maxAgeMinutes - 1),
    },
  }));

/** The longest observed gap between consecutive dispatches of each target. */
function observedGaps(fromUtc: number, toUtc: number): Map<Target, number> {
  const last = new Map<Target, number>();
  const gaps = new Map<Target, number>();
  for (let t = fromUtc; t < toUtc; t += 5 * MINUTE_MS) {
    for (const name of dueTargets(new Date(t))) {
      const previous = last.get(name);
      if (previous !== undefined) {
        gaps.set(
          name,
          Math.max(gaps.get(name) ?? 0, (t - previous) / MINUTE_MS),
        );
      }
      last.set(name, t);
    }
  }
  return gaps;
}

describe("freshness requirements derived from the schedule", () => {
  it("covers every target once, under its live job name, with a tier", () => {
    const violations = checkJobCoverage({ registrySlugs: [...TARGETS] });
    expect(violations).toEqual([]);
    expect(
      OPERATIONAL_COMPLETION_REQUIREMENTS.map((job) => job.target),
    ).toEqual([...TARGETS]);
  });

  it("gives every target, windowed ones included, a budget above its longest dispatch gap", () => {
    // Long enough to cross each weekly, monthly and quarterly window twice.
    const gaps = observedGaps(Date.UTC(2027, 0, 1), Date.UTC(2027, 9, 7));
    for (const job of OPERATIONAL_COMPLETION_REQUIREMENTS) {
      const observed = gaps.get(job.target);
      expect([job.target, maxSlotGapMinutes(job.target)]).toEqual([
        job.target,
        observed,
      ]);
      expect(job.maxAgeMinutes).toBeGreaterThan(observed ?? Infinity);
    }
    expect(requirementFor("tds-return-draft").maxAgeMinutes).toBeGreaterThan(
      91 * 24 * 60,
    );
  });
});

describe("operational absence checks", () => {
  it("reports a job stale once its last run is older than its budget, and fresh within it", () => {
    const job = requirementFor("appointment-reminders");
    const completions = groupRows().map((row) => ({
      jobName: row.jobName,
      endedAt: row._max.endedAt,
    }));
    expect(assessOperationalCompletions({ completions, now }).healthy).toBe(
      true,
    );
    const later = new Date(now.getTime() + 2 * MINUTE_MS);
    const report = assessOperationalCompletions({ completions, now: later });
    expect(report.healthy).toBe(false);
    expect(
      report.jobs.find((row) => row.jobName === job.jobName),
    ).toMatchObject({ overdue: true, tier: "paging" });
  });

  it("lets an overdue watched job redden the report without failing health", () => {
    const report = assessOperationalCompletions({
      completions: groupRows().map((row) => ({
        jobName: row.jobName,
        endedAt: row._max.endedAt,
      })),
      now,
    });
    expect(report.healthy).toBe(true);
    expect(
      report.jobs.find((job) => job.jobName === "prune-audit-logs"),
    ).toMatchObject({ tier: "watched", overdue: true });
  });

  it("refuses unauthorized reads before querying", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("answers 200 when every paging job ran within its budget, reading each only that far back", async () => {
    groupBy.mockResolvedValueOnce(groupRows());
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const where = groupBy.mock.calls[0][0].where;
    expect(where?.result).toEqual({
      path: ["environment"],
      equals: "production",
    });
    const reminders = requirementFor("appointment-reminders");
    expect(where?.AND).toEqual(
      expect.arrayContaining([
        {
          OR: expect.arrayContaining([
            {
              jobName: reminders.jobName,
              startedAt: { gte: minutesAgo(reminders.maxAgeMinutes) },
            },
          ]),
        },
      ]),
    );
    const body = await response.json();
    expect(body.healthy).toBe(true);
    expect(
      body.jobs.every((job: { tier: string }) => job.tier === "paging"),
    ).toBe(true);
  });

  it("answers 503 naming the stale paging job", async () => {
    const job = requirementFor("auth-tokens");
    groupBy.mockResolvedValueOnce(
      groupRows({ [job.jobName]: minutesAgo(job.maxAgeMinutes + 1) }),
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.healthy).toBe(false);
    expect(
      body.jobs.filter((row: { overdue: boolean }) => row.overdue),
    ).toEqual([expect.objectContaining({ jobName: "cleanup-auth-tokens" })]);
  });

  it("counts an idle skip and a config skip as evidence the job ran", async () => {
    const idleJob = requirementFor("appointment-reminders");
    const skippedJob = requirementFor("irp-uploader");
    groupBy.mockResolvedValueOnce([
      ...groupRows().filter(
        (row) =>
          row.jobName !== idleJob.jobName && row.jobName !== skippedJob.jobName,
      ),
      {
        jobName: skippedJob.jobName,
        status: "CANCELLED",
        _max: { endedAt: minutesAgo(30) },
      },
    ]);
    queryRaw.mockResolvedValueOnce([
      { target: idleJob.target, endedAt: minutesAgo(5), skips: 3 },
    ]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.jobs.find(
        (row: { jobName: string }) => row.jobName === skippedJob.jobName,
      ),
    ).toMatchObject({ overdue: false, lastCompletedAt: null });
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

  it("history read failure is unavailable, not healthy or never-run", async () => {
    groupBy.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("JOB_HISTORY_UNAVAILABLE");
  });
});

describe("digest verdicts on the probe", () => {
  /** The newest completed digest row, with one paging-tier standing skip first seen `days` ago. */
  const digestRow = (
    days: number,
    releaseLag: ReleaseLag = unknownReleaseLag("test"),
  ) => ({
    result: {
      environment: "production",
      summary: {
        success: true,
        heartbeat: "pinged",
        headline: "0 new, 1 standing",
        newItems: 0,
        standingItems: 1,
        unavailableSections: [],
        standingSkips: [
          {
            jobName: "irp-uploader",
            tier: "paging",
            reason: "PLATFORM_GSTIN not configured",
            firstSeenAt: minutesAgo(days * 24 * 60).toISOString(),
          },
        ],
        releaseLag,
      },
    },
  });

  const probe = async (keyId: string, days: number) => {
    process.env.RAZORPAY_KEY_ID = keyId;
    groupBy.mockResolvedValueOnce(groupRows());
    mockFindFirst.mockResolvedValueOnce(digestRow(days));
    return GET(request());
  };

  it("answers 503 with live keys and a paging skip older than 7 days", async () => {
    const response = await probe("rzp_live_x", 8);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: false,
      reasons: ["STANDING_CONFIG_SKIP"],
      standingConfigSkips: [
        expect.objectContaining({ jobName: "irp-uploader" }),
      ],
    });
  });

  it("answers 503 when the digest found the release lag overdue", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    groupBy.mockResolvedValueOnce(groupRows());
    mockFindFirst.mockResolvedValueOnce(
      digestRow(1, {
        status: "known",
        buildSha: "abc123",
        commitsBehind: 4,
        oldestUnreleasedAt: minutesAgo(8 * 24 * 60).toISOString(),
        scheduleChangeAt: null,
        touches: [],
        truncated: false,
        overdue: true,
      }),
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      healthy: false,
      reasons: ["RELEASE_LAG_OVERDUE"],
      releaseLag: { overdue: true, commitsBehind: 4 },
    });
  });

  it.each([
    ["test keys", "rzp_test_x", 30],
    ["live keys and a 6-day skip", "rzp_live_x", 6],
  ])("answers 200 with %s", async (_case, keyId, days) => {
    const response = await probe(keyId, days);
    expect(response.status).toBe(200);
    expect((await response.json()).healthy).toBe(true);
  });
});
