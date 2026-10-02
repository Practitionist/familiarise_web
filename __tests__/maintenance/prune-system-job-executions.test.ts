/**
 * @jest-environment node
 */

/**
 * The cron trail (`SystemJobExecution`) had no retention and no reconciler: a
 * run whose process died never reached `recordJobFinish`, so its row stayed
 * RUNNING forever and the table only ever grew. Two windows now govern it, and
 * both are exported as pure functions so the boundaries can be pinned without
 * a database.
 *
 * What matters about these two numbers is their relationship to the rest of the
 * fleet: the stranded window has to sit far enough past the longest possible
 * live run that it can never close one, and the retention window has to sit far
 * enough past the stranded window that a row is always reconciled before it is
 * deleted.
 */

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: {},
    failedEmail: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    failedEmailBatch: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    notificationOutbox: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    emailEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $disconnect: jest.fn(),
  },
}));

import fs from "node:fs";
import path from "node:path";

import prisma from "../../lib/prisma";
import {
  retentionCutoff,
  sentOutboxRetentionCutoff,
  failedEmailBodyScrubCutoff,
  strandedCutoff,
  STRANDED_ERROR,
  pruneMessagingRetentionTables,
} from "../../scripts/cleanup/prune-system-job-executions";

/**
 * Read the longest lock TTL out of the source rather than importing it:
 * `lib/cron/with-cron-lock` pulls in `lib/redis`, which throws at import
 * without Upstash env, and a window check must not need a Redis.
 */
function longestLockTtlMs(): number {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "cron", "with-cron-lock.ts"),
    "utf8",
  );
  const m = src.match(/LONG_JOB_TTL_MS\s*=\s*([\d\s*]+);/);
  if (!m) throw new Error("LONG_JOB_TTL_MS not found in with-cron-lock.ts");
  return m[1]
    .split("*")
    .reduce((product, part) => product * Number(part.trim()), 1);
}

const NOW = new Date("2026-09-02T03:26:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("prune-system-job-executions windows", () => {
  it("keeps ninety days of trail", () => {
    expect(retentionCutoff(NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 90 * DAY).toISOString(),
    );
  });

  it("keeps thirty days of sent messaging and email events, and scrubs sent email bodies after seven days", () => {
    expect(sentOutboxRetentionCutoff(NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 30 * DAY).toISOString(),
    );
    expect(failedEmailBodyScrubCutoff(NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 7 * DAY).toISOString(),
    );
  });

  it("calls a run stranded after six hours", () => {
    expect(strandedCutoff(NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 6 * HOUR).toISOString(),
    );
  });

  it("never declares a run that could still hold its lock stranded", () => {
    // A live run cannot outlast its lock TTL by much, and every workflow caps
    // itself with `timeout-minutes` besides. If the longest TTL ever grows past
    // the stranded window, this sweep would start closing rows out from under
    // running jobs.
    const strandedAgeMs = NOW.getTime() - strandedCutoff(NOW).getTime();
    expect(strandedAgeMs).toBeGreaterThan(longestLockTtlMs() * 2);
  });

  it("reconciles a stranded row long before retention could delete it", () => {
    // Deleting a RUNNING row instead of failing it would erase the evidence
    // that a job died, which is the whole point of closing it.
    expect(retentionCutoff(NOW).getTime()).toBeLessThan(
      strandedCutoff(NOW).getTime(),
    );
  });

  it("stamps a reason an operator can grep for", () => {
    expect(STRANDED_ERROR).toBe("stranded (no heartbeat)");
  });
});

describe("pruneMessagingRetentionTables", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("scrubs 7-day-old SENT FailedEmail bodies and deletes expired FailedEmail, FailedEmailBatch, NotificationOutbox, and EmailEvent rows in bounded batches", async () => {
    const fe = prisma.failedEmail as unknown as {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    const feb = prisma.failedEmailBatch as unknown as {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    const outbox = prisma.notificationOutbox as unknown as {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    const emailEvent = prisma.emailEvent as unknown as {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };

    // 1st findMany on failedEmail is for body scrub; 2nd is for deletion.
    fe.findMany
      .mockResolvedValueOnce([{ id: "fe-scrub-1" }])
      .mockResolvedValueOnce([{ id: "fe-del-1" }]);
    fe.updateMany.mockResolvedValueOnce({ count: 1 });
    fe.deleteMany.mockResolvedValueOnce({ count: 1 });

    feb.findMany.mockResolvedValueOnce([{ id: "feb-del-1" }]);
    feb.deleteMany.mockResolvedValueOnce({ count: 1 });

    outbox.findMany.mockResolvedValueOnce([{ id: "no-del-1" }]);
    outbox.deleteMany.mockResolvedValueOnce({ count: 1 });

    emailEvent.findMany.mockResolvedValueOnce([{ id: "ee-del-1" }]);
    emailEvent.deleteMany.mockResolvedValueOnce({ count: 1 });

    const counts = await pruneMessagingRetentionTables(NOW);

    expect(counts).toEqual({
      failedEmailsBodyScrubbed: 1,
      failedEmailsPruned: 1,
      failedEmailBatchesPruned: 1,
      notificationOutboxPruned: 1,
      emailEventsPruned: 1,
    });
    expect(fe.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["fe-scrub-1"] } },
      data: { htmlBody: "", textBody: null },
    });
  });
});
