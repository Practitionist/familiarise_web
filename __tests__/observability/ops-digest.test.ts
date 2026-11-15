/** @jest-environment node */
import { OPERATIONAL_COMPLETION_REQUIREMENTS } from "@/lib/cron/operational-health";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@sentry/core", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("@/lib/email/deliver", () => ({ deliver: jest.fn() }));

const now = new Date("2026-11-03T03:30:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const DAY_MS = 24 * 60 * 60 * 1000;

interface GroupByArgs {
  by: string[];
  where?: { status?: unknown };
  _min?: unknown;
}

/** The newest skip row, the streak start and its reason, when a skip is standing. */
let standingSkip: { lastSeen: Date; firstSeen: Date } | null = null;

const watchedFresh = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
  (job) => job.tier === "watched",
).map((job) => ({
  jobName: job.jobName,
  status: "COMPLETED",
  _max: { endedAt: ago(60_000) },
}));

const mockDb = {
  systemJobExecution: {
    groupBy: jest.fn(async (args: GroupByArgs) => {
      if (args.by.length === 2) return watchedFresh;
      if (!standingSkip) return [];
      if (args._min) {
        return [
          {
            jobName: "irp-uploader",
            _min: { startedAt: standingSkip.firstSeen },
          },
        ];
      }
      if (args.where?.status === "CANCELLED") {
        return [
          {
            jobName: "irp-uploader",
            _max: { startedAt: standingSkip.lastSeen },
          },
        ];
      }
      return [];
    }),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () =>
      standingSkip
        ? [
            {
              jobName: "irp-uploader",
              result: { reason: "PLATFORM_GSTIN not configured" },
            },
          ]
        : [],
    ),
  },
  $queryRaw: jest.fn(async (query: { sql: string }) => {
    if (query.sql.includes('"refundsOwed"')) {
      return [
        {
          refundsOwed: 0,
          payoutsStuck: 0,
          dunningNotices: 0,
          disputesDue: 0,
          webhookEvents: 0,
          emailRetries: 0,
          notificationRetries: 0,
        },
      ];
    }
    if (query.sql.includes("'telemetry'")) {
      return [{ sent: 3, r402: 0, r403: 0, r5xx: 0, network: 0, other: 0 }];
    }
    return [];
  }),
  failedEmail: {
    groupBy: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    findMany: jest.fn(async () => []),
  },
  notificationOutbox: {
    count: jest.fn(async () => 0),
    findMany: jest.fn(async () => []),
  },
  outboundWebhookDelivery: {
    count: jest.fn(async () => 0),
    findMany: jest.fn(async () => []),
  },
  webhookEvent: {
    count: jest.fn(async () => 0),
    findMany: jest.fn(async () => []),
    groupBy: jest.fn(async () => []),
  },
  emailEvent: {
    aggregate: jest.fn(async () => ({ _max: { receivedAt: null } })),
  },
  payment: {
    aggregate: jest.fn(async () => ({ _sum: { amount: 0, taxAmount: 0 } })),
  },
  referralCreditUsage: {
    aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
  },
  refund: { aggregate: jest.fn(async () => ({ _sum: { amountPaise: 0 } })) },
  streamRevocationRetry: {
    count: jest.fn(async (_args?: unknown) => 0),
    findMany: jest.fn(async (_args?: unknown) => [] as { id: string }[]),
  },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));

import * as SentryCore from "@sentry/core";
import * as SentryNext from "@sentry/nextjs";
import { deliver } from "@/lib/email/deliver";
import { runOpsDigest } from "@/lib/observability/ops-digest";
import { reportSentryError } from "@/lib/observability/report";

const deliverMock = jest.mocked(deliver);
const fetchMock = jest.fn(async () => new Response(null, { status: 200 }));
const HEARTBEAT = "https://uptime.betterstack.com/api/v1/heartbeat/digest";
const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.streamRevocationRetry.count.mockResolvedValue(0);
  mockDb.streamRevocationRetry.findMany.mockResolvedValue([]);
  standingSkip = null;
  process.env = {
    ...originalEnv,
    BETTERSTACK_DIGEST_HEARTBEAT_URL: HEARTBEAT,
    OBSERVABILITY_ALERT_EMAIL: "ops@familiarisenow.com",
  };
  delete process.env.BETTERSTACK_API_KEY;
  delete process.env.UPSTASH_MANAGEMENT_API_KEY;
  global.fetch = fetchMock;
  deliverMock.mockResolvedValue({ success: true, staged: true });
});
afterAll(() => {
  process.env = originalEnv;
});

const run = () => runOpsDigest({ now, environment: "production" });
const sentEmail = () => deliverMock.mock.calls[0][0];

describe("daily ops digest", () => {
  it("sends an All clear digest on a quiet day, then pings the heartbeat", async () => {
    const result = await run();
    expect(result).toMatchObject({
      success: true,
      heartbeat: "pinged",
      headline: "All clear",
      unavailableSections: [],
    });
    expect(sentEmail()).toMatchObject({
      to: "ops@familiarisenow.com",
      subject: "[Familiarise] Ops digest 2026-11-03: All clear",
    });
    expect(fetchMock).toHaveBeenCalledWith(HEARTBEAT, expect.anything());
    expect(deliverMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
  });

  it("shows a standing config skip with the age of its streak", async () => {
    process.env.PLATFORM_GSTIN = "06ABCDE1234F1Z5";
    standingSkip = { lastSeen: ago(60 * 60_000), firstSeen: ago(40 * DAY_MS) };
    const result = await run();
    expect(result.headline).toBe("0 new, 1 standing");
    expect(result.standingSkips).toEqual([
      {
        jobName: "irp-uploader",
        tier: "paging",
        reason: "PLATFORM_GSTIN not configured",
        firstSeenAt: ago(40 * DAY_MS).toISOString(),
      },
    ]);
    expect(sentEmail().text).toContain(
      "Config skips: irp-uploader: PLATFORM_GSTIN not configured, 40 days (paging)",
    );
  });

  it("keeps a GST job's skip out of the paging summary while unregistered", async () => {
    delete process.env.PLATFORM_GSTIN;
    standingSkip = { lastSeen: ago(60 * 60_000), firstSeen: ago(40 * DAY_MS) };
    const result = await run();
    expect(result.standingSkips).toEqual([]);
    expect(sentEmail().text).toContain(
      "Expected while unregistered for GST: irp-uploader.",
    );
  });

  it.each([
    [
      "a refused send",
      () =>
        deliverMock.mockResolvedValue({
          success: false,
          error: new Error("held"),
        }),
    ],
    ["a thrown send", () => deliverMock.mockRejectedValue(new Error("down"))],
  ])("pings the heartbeat's /fail on %s", async (_case, arrange) => {
    arrange();
    const result = await run();
    expect(result).toMatchObject({ success: false, heartbeat: "pinged-fail" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${HEARTBEAT}/fail`,
      expect.anything(),
    );
  });

  it("lists access revocations still owed past their retry cap, the newly crossed ones as new", async () => {
    mockDb.streamRevocationRetry.count.mockImplementation(
      async (args?: unknown) => {
        const { where } = args as { where: { attempts: unknown } };
        return typeof where.attempts === "number" ? 1 : 3;
      },
    );
    mockDb.streamRevocationRetry.findMany.mockResolvedValue([{ id: "rev-1" }]);
    const result = await run();
    expect(mockDb.streamRevocationRetry.count).toHaveBeenCalledWith({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        kind: {
          in: ["SEAT_ACCESS_REVOKE", "REFUND_ACCESS_REVOKE", "ERASURE_REVOKE"],
        },
        attempts: { gte: 6 },
      },
    });
    expect(result.headline).toBe("1 new, 0 standing");
    expect(sentEmail().text).toContain(
      "3 Stream access revocations still owed past the retry cap (1 new)",
    );
    expect(sentEmail().text).toContain("rev-1");
  });

  it("records an unset heartbeat URL instead of throwing, and never calls Sentry", async () => {
    delete process.env.BETTERSTACK_DIGEST_HEARTBEAT_URL;
    mockDb.failedEmail.count.mockRejectedValueOnce(new Error("pool timeout"));
    const result = await run();
    expect(result).toMatchObject({
      success: true,
      heartbeat: "not-configured",
      unavailableSections: ["Dead letters"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const fn of [
      SentryCore.captureException,
      SentryCore.captureMessage,
      SentryNext.captureException,
      SentryNext.captureMessage,
      reportSentryError,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
