/**
 * Finds in-app steps that failed inside Novu after it accepted the trigger, by
 * reading Novu's activity feed (`GET /v1/notifications`), and records each as a
 * `review:` dead letter beside its outbox row. The parent row is never changed
 * and nothing is re-sent: Novu treats a repeated transactionId as a duplicate.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { reportConfigSkip, type ConfigSkip } from "@/lib/cron/config-skip";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  outboxTransactionIdOf,
  recipientTransactionId,
} from "@/lib/novu/outbox";
import { resolveNovuSecretKey } from "@/lib/novu/secret-key";
import prisma, { type PrismaLike } from "@/lib/prisma";

export const NOVU_STEP_FAILED = "review:novu_step_failed";

/** Twice the 2-hour cadence, so every event is read by two runs; Free keeps 24 h. */
export const PROBE_WINDOW_MS = 4 * 60 * 60_000;
/** Novu's page-size maximum for this endpoint. */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 10;
/** No page starts past this, so the last 5 s request ends inside the 20 s target timeout. */
const PAGE_START_BUDGET_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REASON_LENGTH = 200;
/** The SDK's default server, which lib/novu/client.ts uses. */
const NOVU_API_BASE = "https://api.novu.co";

const executionDetailSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
  raw: z.string().nullish(),
});

const activitySchema = z.object({
  transactionId: z.string().optional(),
  subscriber: z.object({ subscriberId: z.string() }).nullish(),
  // `to` takes several shapes; only the one naming a subscriberId is read.
  to: z.object({ subscriberId: z.string().optional() }).nullish().catch(null),
  jobs: z
    .array(
      z.object({
        type: z.string(),
        status: z.string(),
        executionDetails: z.array(executionDetailSchema).default([]),
      }),
    )
    .default([]),
});

const pageSchema = z.object({
  hasMore: z.boolean(),
  data: z.array(activitySchema),
});

const rawErrorSchema = z.object({
  code: z.string().optional(),
  data: z.array(z.object({ path: z.string().optional() })).optional(),
});

type Activity = z.infer<typeof activitySchema>;
type ExecutionDetail = z.infer<typeof executionDetailSchema>;

export interface StepFailureProbeResult {
  scanned: number;
  pages: number;
  failedSteps: number;
  matched: number;
  inserted: number;
  unmatched: number;
  /** The page cap, the budget or a 429 stopped paging before the window was read. */
  truncated: boolean;
  skipped?: ConfigSkip;
}

/** The step's error code and output paths only: Novu's free-text message can quote the payload. */
export function stepFailureReason(details: readonly ExecutionDetail[]): string {
  const failed = details.findLast((d) => d.status === "Failed");
  const detail = failed?.detail ?? "Novu step failed";
  let raw: z.infer<typeof rawErrorSchema> | undefined;
  try {
    const parsed = rawErrorSchema.safeParse(JSON.parse(failed?.raw ?? ""));
    raw = parsed.success ? parsed.data : undefined;
  } catch {
    raw = undefined;
  }
  const paths = (raw?.data ?? []).flatMap((d) => (d.path ? [d.path] : []));
  const where = [raw?.code, paths.length ? `at ${paths.join(", ")}` : null]
    .filter(Boolean)
    .join(" ");
  const reason = `${NOVU_STEP_FAILED}: ${detail}${where ? ` (${where})` : ""}`;
  return reason.slice(0, MAX_REASON_LENGTH);
}

interface Failure {
  rowTransactionId: string;
  recipient: string;
  suffix: string;
  reason: string;
}

/** A failed in-app step whose transactionId is one of our per-recipient ids, else null. */
function failureOf(activity: Activity): Failure | "unmatched" | null {
  const failedJob = activity.jobs.find(
    (job) => job.type === "in_app" && job.status === "failed",
  );
  if (!failedJob) return null;
  const novuId = activity.transactionId;
  const recipient =
    activity.subscriber?.subscriberId ?? activity.to?.subscriberId;
  if (!novuId || !recipient) return "unmatched";
  const rowTransactionId = outboxTransactionIdOf(novuId);
  if (
    rowTransactionId === novuId ||
    recipientTransactionId(rowTransactionId, recipient) !== novuId
  ) {
    return "unmatched";
  }
  return {
    rowTransactionId,
    recipient,
    suffix: novuId.slice(rowTransactionId.length + 1),
    reason: stepFailureReason(failedJob.executionDetails),
  };
}

export type FetchPage = (
  query: URLSearchParams,
  secretKey: string,
) => Promise<Response>;

const fetchNovuPage: FetchPage = (query, secretKey) =>
  fetch(`${NOVU_API_BASE}/v1/notifications?${query.toString()}`, {
    headers: { Authorization: `ApiKey ${secretKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

export interface StepFailureProbeOptions {
  db?: PrismaLike;
  fetchPage?: FetchPage;
  now?: () => number;
}

async function readFailures(
  secretKey: string,
  fetchPage: FetchPage,
  now: () => number,
): Promise<{
  failures: Failure[];
  scanned: number;
  pages: number;
  failedSteps: number;
  unmatched: number;
  truncated: boolean;
}> {
  const startedAt = now();
  const before = new Date(startedAt).toISOString();
  const after = new Date(startedAt - PROBE_WINDOW_MS).toISOString();
  const failures: Failure[] = [];
  let scanned = 0;
  let failedSteps = 0;
  let unmatched = 0;
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    if (page >= MAX_PAGES || now() - startedAt > PAGE_START_BUDGET_MS) break;
    const query = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      after,
      before,
    });
    query.append("channels", "in_app");
    const response = await fetchPage(query, secretKey);
    // Rate-limited: stop here; the overlapping window reads the rest next run.
    if (response.status === 429) break;
    if (!response.ok) {
      throw new Error(`Novu activity read failed with HTTP ${response.status}`);
    }
    const body = pageSchema.parse(await response.json());
    page++;
    hasMore = body.hasMore;
    scanned += body.data.length;
    for (const activity of body.data) {
      const failure = failureOf(activity);
      if (failure === null) continue;
      failedSteps++;
      if (failure === "unmatched") unmatched++;
      else failures.push(failure);
    }
  }
  return {
    failures,
    scanned,
    pages: page,
    failedSteps,
    unmatched,
    truncated: hasMore,
  };
}

/** One SINGLE dead letter per failed recipient; its unique transactionId makes a re-read a no-op. */
async function recordFailures(
  db: PrismaLike,
  failures: readonly Failure[],
): Promise<{ matched: number; inserted: number }> {
  if (failures.length === 0) return { matched: 0, inserted: 0 };
  const parents = await db.notificationOutbox.findMany({
    where: {
      transactionId: {
        in: [...new Set(failures.map((f) => f.rowTransactionId))],
      },
    },
    select: {
      transactionId: true,
      workflowId: true,
      payload: true,
      entityRef: true,
      attempts: true,
      firstAttemptAt: true,
    },
  });
  const byTransactionId = new Map(parents.map((p) => [p.transactionId, p]));
  const rows: Prisma.NotificationOutboxCreateManyInput[] = [];
  for (const failure of failures) {
    const parent = byTransactionId.get(failure.rowTransactionId);
    if (!parent) continue;
    rows.push({
      workflowId: parent.workflowId,
      kind: "SINGLE",
      recipients: [failure.recipient],
      payload: parent.payload ?? {},
      transactionId: `${failure.rowTransactionId}:stepfailed:${failure.suffix}`,
      entityRef: parent.entityRef,
      status: "DEAD_LETTER",
      attempts: parent.attempts,
      firstAttemptAt: parent.firstAttemptAt,
      lastError: failure.reason,
    });
  }
  if (rows.length === 0) return { matched: 0, inserted: 0 };
  const { count } = await db.notificationOutbox.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return { matched: rows.length, inserted: count };
}

export async function probeNovuStepFailures(
  opts: StepFailureProbeOptions = {},
): Promise<StepFailureProbeResult> {
  const { name, key } = resolveNovuSecretKey();
  if (!key) {
    const skipped: ConfigSkip = `${name} not configured`;
    reportConfigSkip("novu-step-failure-probe", skipped);
    return {
      scanned: 0,
      pages: 0,
      failedSteps: 0,
      matched: 0,
      inserted: 0,
      unmatched: 0,
      truncated: false,
      skipped,
    };
  }
  // Fail-open: a read of Novu plus idempotent inserts, safe to run twice.
  return withCronLock(
    "novu-step-failure-probe",
    { failMode: "open" },
    async () => {
      const read = await readFailures(
        key,
        opts.fetchPage ?? fetchNovuPage,
        opts.now ?? Date.now,
      );
      const written = await recordFailures(opts.db ?? prisma, read.failures);
      return {
        scanned: read.scanned,
        pages: read.pages,
        failedSteps: read.failedSteps,
        matched: written.matched,
        inserted: written.inserted,
        unmatched: read.unmatched + read.failures.length - written.matched,
        truncated: read.truncated,
      };
    },
  );
}
