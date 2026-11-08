/**
 * @jest-environment node
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import {
  MAX_PAGES,
  NOVU_STEP_FAILED,
  PAGE_SIZE,
  PROBE_WINDOW_MS,
  probeNovuStepFailures,
  type FetchPage,
} from "../../jobs/notifications/novu-step-failure-probe";
import {
  deriveTransactionId,
  recipientTransactionId,
} from "../../lib/novu/outbox";
import type { PrismaLike } from "../../lib/prisma";

const ROW_TX = deriveTransactionId("platform", ["u1", "u2"], { title: "t" });
const NOW = Date.UTC(2026, 10, 7, 12, 0);

const PARENT = {
  transactionId: ROW_TX,
  workflowId: "platform",
  payload: { title: "t" },
  entityRef: "announcement:1",
  attempts: 1,
  firstAttemptAt: new Date(NOW - 60_000),
};

const BRIDGE_FAILED = {
  status: "Failed",
  detail: "Bridge execution failed",
  raw: JSON.stringify({
    message: "Step output for u2@example.com is invalid",
    code: "ExecutionStateOutputInvalidError",
    data: [{ path: "/redirect/url", message: "must match pattern" }],
  }),
};

function activity(
  transactionId: string,
  subscriberId: string,
  status = "failed",
  type = "in_app",
) {
  return {
    _id: "n1",
    transactionId,
    _subscriberId: "internal-mongo-id",
    subscriber: { _id: "s1", subscriberId },
    jobs: [{ type, status, executionDetails: [BRIDGE_FAILED] }],
  };
}

function feed(pages: unknown[][], status = 200): jest.Mock {
  return jest.fn(async (query: URLSearchParams) => {
    const page = Number(query.get("page"));
    return Response.json(
      {
        page,
        pageSize: PAGE_SIZE,
        hasMore: page < pages.length - 1,
        data: pages[page] ?? [],
      },
      { status },
    );
  });
}

function store(inserted = 1) {
  const findMany = jest.fn(async () => [PARENT]);
  const createMany = jest.fn(async () => ({ count: inserted }));
  const db = { notificationOutbox: { findMany, createMany } };
  return { db: db as unknown as PrismaLike, findMany, createMany };
}

const run = (fetchPage: FetchPage, db: PrismaLike) =>
  probeNovuStepFailures({ db, fetchPage, now: () => NOW });

beforeEach(() => {
  process.env.NOVU_DEVELOPMENT_KEY = "test-key";
});

describe("novu-step-failure-probe", () => {
  it("dead-letters a failed in-app step beside its row, with no PII in the reason", async () => {
    const { db, createMany } = store();
    const fetchPage = feed([
      [activity(recipientTransactionId(ROW_TX, "u2"), "u2")],
    ]);

    const result = await run(fetchPage, db);

    const query: URLSearchParams = fetchPage.mock.calls[0][0];
    expect(query.get("channels")).toBe("in_app");
    expect(query.get("limit")).toBe(String(PAGE_SIZE));
    expect(
      Date.parse(query.get("before")!) - Date.parse(query.get("after")!),
    ).toBe(PROBE_WINDOW_MS);
    expect(fetchPage.mock.calls[0][1]).toBe("test-key");
    const suffix = recipientTransactionId(ROW_TX, "u2").slice(
      ROW_TX.length + 1,
    );
    expect(createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        {
          workflowId: "platform",
          kind: "SINGLE",
          recipients: ["u2"],
          payload: { title: "t" },
          transactionId: `${ROW_TX}:stepfailed:${suffix}`,
          entityRef: "announcement:1",
          status: "DEAD_LETTER",
          attempts: 1,
          firstAttemptAt: PARENT.firstAttemptAt,
          lastError: `${NOVU_STEP_FAILED}: Bridge execution failed (ExecutionStateOutputInvalidError at /redirect/url)`,
        },
      ],
    });
    expect(result).toMatchObject({
      failedSteps: 1,
      matched: 1,
      inserted: 1,
      truncated: false,
    });
  });

  it("counts a re-read failure as matched but inserts nothing", async () => {
    const { db } = store(0);
    const fetchPage = feed([
      [activity(recipientTransactionId(ROW_TX, "u2"), "u2")],
    ]);

    await expect(run(fetchPage, db)).resolves.toMatchObject({
      matched: 1,
      inserted: 0,
    });
  });

  it("ignores foreign ids, mismatched recipients, missing rows and steps that did not fail", async () => {
    const { db, findMany, createMany } = store();
    findMany.mockResolvedValue([]);
    const orphanTx = deriveTransactionId("platform", ["u9"], { title: "x" });
    const fetchPage = feed([
      [
        activity("txn_6aee1b88ya37j5jd6mu5", "u2"),
        activity(recipientTransactionId(ROW_TX, "u1"), "u2"),
        activity(recipientTransactionId(orphanTx, "u9"), "u9"),
        activity(recipientTransactionId(ROW_TX, "u2"), "u2", "completed"),
        activity(recipientTransactionId(ROW_TX, "u2"), "u2", "failed", "email"),
      ],
    ]);

    const result = await run(fetchPage, db);

    expect(createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 5,
      failedSteps: 3,
      matched: 0,
      unmatched: 3,
    });
  });

  it("pages until hasMore is false and stops at the page cap", async () => {
    const { db } = store();
    const pages = Array.from({ length: MAX_PAGES + 2 }, () => [
      activity("foreign", "u2", "completed"),
    ]);
    const fetchPage = feed(pages);

    const result = await run(fetchPage, db);

    expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
    expect(result).toMatchObject({
      pages: MAX_PAGES,
      scanned: MAX_PAGES,
      truncated: true,
    });
  });

  it("stops quietly on a 429 and throws on any other refusal", async () => {
    const { db } = store();
    await expect(run(feed([[]], 429), db)).resolves.toMatchObject({
      pages: 0,
      truncated: true,
    });
    await expect(run(feed([[]], 401), db)).rejects.toThrow("HTTP 401");
  });

  it("skips without calling Novu when the key is absent", async () => {
    delete process.env.NOVU_DEVELOPMENT_KEY;
    const { db } = store();
    const fetchPage = feed([[]]);

    const result = await run(fetchPage, db);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.skipped).toBe("NOVU_DEVELOPMENT_KEY not configured");
  });
});
