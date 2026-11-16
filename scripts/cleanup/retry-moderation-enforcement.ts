/**
 * Moderation enforcement retry sweep (#1270).
 *
 * The moderation action route runs its Stream write best-effort: the ban row,
 * the session revocation, the cancellations and the refunds all commit, and if
 * Stream happens to be down (or the circuit breaker is open) the harasser's
 * existing chat token keeps working for up to an hour. The failure was recorded
 * in `ModerationAction.sideEffects` and then nothing ever retried it, because
 * the route's 409 idempotency guard — which is what stops a double refund —
 * also blocks the only path that could have re-run the Stream step.
 *
 * This sweep drains exactly that queue. It reuses the durability shape of
 * `sweep-stuck-webhook-events`: select the rows whose recorded outcome says
 * "failed", re-drive the same code the live path runs, write the new outcome
 * back, and stamp a terminal marker once a row has aged or been attempted past
 * its budget so a permanently broken one stops churning. The `sideEffects` JSON
 * IS the outbox — there is no second table to keep in step with it.
 *
 * Re-driving is safe because every Stream step is idempotent (see
 * applyStreamEnforcement) and because a step is skipped outright once the state
 * that justified it is gone: a lifted ban is never re-revoked.
 *
 * #1580 — the same queue carries a failed collaborator revocation
 * (`sideEffects.collaboratorRevocation`): the rows are REMOVED for good, so
 * the per-plan Stream removal is re-driven regardless of the ban's fate.
 */
import type {
  CollaboratorType,
  ModerationActionType,
  ModerationReportType,
  Prisma,
  StreamRevocationKind,
} from "@prisma/client";
import type { AccessRevocationRow } from "@/lib/stream/access-revocation";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { nextRetryAt } from "@/lib/retry/backoff";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { SWEEP_START_DEADLINE_MS } from "@/lib/cron/run-deadline";
import { reportSentryError } from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import {
  isUncappedRevocationKind,
  PAST_CAP_RETRY_MS,
  REVOCATION_ATTEMPT_CAP,
  UNCAPPED_REVOCATION_KINDS,
} from "@/lib/stream/revocation-retry-policy";
import {
  applyStreamEnforcement,
  restoreStreamAccess,
  streamErrorPrefix,
  type ModerationReportRef,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";

export interface ModerationRetryResult {
  success: boolean;
  scanned: number;
  /** The Stream step landed on this attempt. */
  recovered: number;
  /** Still failing; will be attempted again next run. */
  stillFailing: number;
  /** Terminally capped — out of attempts or too old for the retry to mean anything. */
  gaveUp: number;
  /** No longer applicable: the ban was lifted, so re-revoking would be harmful. */
  skipped: number;
  /** #1580 — collaborator Stream revocations that landed on this attempt. */
  collaboratorRecovered: number;
  /** #1593 — erasure requests whose owed Stream revocations were re-driven. */
  erasureRevocationsRecovered: number;
  /** Queued cancellation, collaborator and org-removal revocations that landed. */
  accessRevocationsRecovered: number;
  /** Owed Stream revocations and erasures left untouched because Stream's keys are missing or refused. */
  streamUnconfigured: number;
  errors: string[];
}

export interface ModerationRetryOptions {
  /** Attempts, counting the original one made by the action route. */
  maxAttempts?: number;
  /**
   * Past this age a retry stops being a repair. A ban whose Stream revocation
   * never landed in three days needs an operator, not a seventh attempt.
   */
  giveUpAfterHours?: number;
  limit?: number;
}

// Per-row give-ups and write failures collapse to one event per op per run.
const runFailures = createRunFailureReporter("moderation");

const MAX_ATTEMPTS = REVOCATION_ATTEMPT_CAP;

/** A seat or refund revocation is not started with less than this left before the run deadline. */
const MIN_SEAT_REVOCATION_SLICE_MS = 5_000;

const RETRYABLE_ACTIONS: ModerationActionType[] = [
  "USER_BANNED",
  "USER_SUSPENDED",
  "CONTENT_REMOVED",
  "USER_REINSTATED",
];

// `stream: "failed"` and `collaboratorRevocation: "failed"` are the queue; a
// capped row is marked "gave_up" and so falls out of this selector by construction.
const FAILED_ENFORCEMENT_WHERE: Prisma.ModerationActionWhereInput = {
  actionType: { in: RETRYABLE_ACTIONS },
  OR: [
    { sideEffects: { path: ["stream"], equals: "failed" } },
    {
      sideEffects: { path: ["collaboratorRevocation"], equals: "failed" },
    },
  ],
};

/** Owed revocations due now; a capped kind past the attempt budget already wrote its give-up. */
function streamRevocationDueWhere(
  now: Date,
): Prisma.StreamRevocationRetryWhereInput {
  return {
    status: { in: ["PENDING", "FAILED"] },
    AND: [
      {
        OR: [
          { attempts: { lt: MAX_ATTEMPTS } },
          { kind: { in: [...UNCAPPED_REVOCATION_KINDS] } },
        ],
      },
      { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
    ],
  };
}

function vendorErasureDueWhere(now: Date): Prisma.VendorErasureRetryWhereInput {
  return {
    status: { in: ["PENDING", "FAILED"] },
    attempts: { lt: MAX_ATTEMPTS },
    OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
  };
}

/** Ticker idle probe: a failed enforcement, an owed revocation or a vendor erasure due now. */
export async function hasModerationRetryWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const action = await db.moderationAction.findFirst({
    where: FAILED_ENFORCEMENT_WHERE,
    select: { id: true },
  });
  if (action) return true;
  if (outOfTime()) return true;
  const revocation = await db.streamRevocationRetry.findFirst({
    where: streamRevocationDueWhere(now),
    select: { id: true },
  });
  if (revocation) return true;
  if (outOfTime()) return true;
  const erasure = await db.vendorErasureRetry.findFirst({
    where: vendorErasureDueWhere(now),
    select: { id: true },
  });
  return erasure !== null;
}

type ActionRow = {
  id: string;
  actionType: ModerationActionType;
  createdAt: Date;
  sideEffects: unknown;
  report: {
    id: string;
    type: ModerationReportType;
    targetUserId: string;
    reviewId: string | null;
    streamMessageId: string | null;
    streamChannelCid: string | null;
  };
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function summaryOf(row: ActionRow): SideEffectSummary {
  return (row.sideEffects ?? {}) as SideEffectSummary;
}

function reportRefOf(row: ActionRow): ModerationReportRef {
  return {
    id: row.report.id,
    type: row.report.type,
    targetUserId: row.report.targetUserId,
    reviewId: row.report.reviewId,
    streamMessageId: row.report.streamMessageId,
    // #1270 review — the delete needs the channel too. Selecting only the id
    // meant the re-drive could not address the message it was retrying.
    streamChannelCid: row.report.streamChannelCid,
  };
}

async function writeSummary(
  actionId: string,
  summary: SideEffectSummary,
): Promise<void> {
  await prisma.moderationAction.update({
    where: { id: actionId },
    // NOT structuredClone (Sonar S7784) — see the note in
    // lib/moderation/side-effects.ts. Optional fields must be dropped, not
    // preserved as `undefined`, for Prisma's InputJsonValue.
    data: { sideEffects: JSON.parse(JSON.stringify(summary)) },
  });
}

/**
 * Is the account state that justified this Stream step still in force?
 *
 * A ban that has since been lifted must not be re-enforced — re-revoking a
 * reinstated user's tokens would kick them out of chat all over again, which is
 * the very defect the reinstatement was undoing. A suspension whose `banExpires`
 * has passed is over for the same reason, even though the column stays `true`
 * until the target next signs in and the auth plugin clears it lazily.
 */
async function stillApplicable(row: ActionRow): Promise<boolean> {
  if (row.actionType === "CONTENT_REMOVED") return true;
  if (row.actionType === "USER_REINSTATED") return true;

  const user = await prisma.user.findUnique({
    where: { id: row.report.targetUserId },
    select: { banned: true, banExpires: true },
  });
  if (!user?.banned) return false;
  return !(user.banExpires && user.banExpires.getTime() <= Date.now());
}

// #476 — every scheduled entry shares one mutual exclusion. Fail-closed: two
// concurrent sweeps could both read `attempts: 2` and burn the budget twice.
export async function retryModerationEnforcement(
  opts: ModerationRetryOptions = {},
): Promise<ModerationRetryResult> {
  // Flush inside the lock: a call refused by the lock never flushes the
  // running sweep's failures.
  return withCronLock(
    "retry-moderation-enforcement",
    { failMode: "closed" },
    async () => {
      try {
        return await retryModerationEnforcementUnlocked(opts);
      } finally {
        runFailures.flush();
      }
    },
  );
}

async function retryModerationEnforcementUnlocked(
  opts: ModerationRetryOptions = {},
): Promise<ModerationRetryResult> {
  const runStartedAt = Date.now();
  const maxAttempts = opts.maxAttempts ?? 6;
  const giveUpAfterHours = opts.giveUpAfterHours ?? 72;
  const limit = opts.limit ?? 100;
  const giveUpOlderThan = new Date(Date.now() - giveUpAfterHours * 3_600_000);

  const rows = (await prisma.moderationAction.findMany({
    where: FAILED_ENFORCEMENT_WHERE,
    select: {
      id: true,
      actionType: true,
      createdAt: true,
      sideEffects: true,
      report: {
        select: {
          id: true,
          type: true,
          targetUserId: true,
          reviewId: true,
          streamMessageId: true,
          streamChannelCid: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  })) as ActionRow[];

  const result: ModerationRetryResult = {
    success: true,
    scanned: rows.length,
    recovered: 0,
    stillFailing: 0,
    gaveUp: 0,
    skipped: 0,
    collaboratorRecovered: 0,
    erasureRevocationsRecovered: 0,
    accessRevocationsRecovered: 0,
    streamUnconfigured: 0,
    errors: [],
  };

  for (const row of rows) {
    const summary = summaryOf(row);
    const budget = { maxAttempts, giveUpOlderThan };
    if (summary.stream === "failed")
      await retryOne(row, summary, budget, result);
    if (summary.collaboratorRevocation === "failed") {
      await retryCollaboratorRevocation(row, summary, budget, result);
    }
  }

  // The erasure scrub records the Stream revocations and vendor
  // erasures it could not land; there is no erasure sweep of its own, so this
  // one drains them.
  const settledRequestIds = new Set<string>();
  const { isStreamConfigured } = await import("@/lib/stream-client");
  const streamReady = isStreamConfigured();
  if (streamReady) {
    await drainErasureRevocations(
      result,
      limit,
      settledRequestIds,
      runStartedAt + SWEEP_START_DEADLINE_MS,
    );
  } else {
    result.streamUnconfigured += await prisma.streamRevocationRetry.count({
      where: streamRevocationDueWhere(new Date()),
    });
  }
  await drainVendorErasureRetries(
    result,
    limit,
    settledRequestIds,
    streamReady,
  );
  await finalizeCompletedErasureRequests(settledRequestIds);
  if (result.streamUnconfigured > 0) await reportStreamUnconfigured(result);

  // #1270 review — a sweep that left enforcement unlanded did not succeed.
  // `jobs/` reads this to decide the workflow's exit code.
  result.success = result.errors.length === 0 && result.gaveUp === 0;

  return result;
}

/** The rows were not attempted, so they keep their attempts and stay due; Sentry hears once a day across instances. */
async function reportStreamUnconfigured(
  result: ModerationRetryResult,
): Promise<void> {
  const message = `Stream not configured: ${result.streamUnconfigured} owed Stream revocations or erasures left pending`;
  result.errors.push(message);
  console.warn(
    JSON.stringify({
      event: "cron.config-skip",
      job: "retry-moderation-enforcement",
      skipped: "Stream not configured",
      rows: result.streamUnconfigured,
    }),
  );
  await reportStandingFinding(
    {
      key: "retry-moderation-enforcement:stream-unconfigured",
      ids: ["stream-keys"],
      message: "Stream not configured: owed Stream revocations stay pending",
    },
    () =>
      reportSentryError(new Error(message), {
        subsystem: "moderation",
        op: "stream-unconfigured",
        level: "warning",
        extra: { rows: result.streamUnconfigured },
      }),
  );
}

async function executeErasureRevocationRow(
  row: {
    planType: string | null;
    planId: string;
    erasureRequest: { userId: string };
  },
  deps: {
    principalPrefix: string;
    eraseStreamPrincipalFootprint: (userId: string) => Promise<void>;
    revokeCollaboratorAccess: (
      planType: "webinar" | "class",
      planId: string,
      userId: string,
    ) => Promise<{ success: boolean }>;
  },
): Promise<string | null> {
  if (row.planId.startsWith(deps.principalPrefix)) {
    try {
      await deps.eraseStreamPrincipalFootprint(row.erasureRequest.userId);
      return null;
    } catch (error_) {
      return errMsg(error_);
    }
  }
  if (!row.planType) return "Erasure retry has no plan type";
  const planType = row.planType === "WEBINAR" ? "webinar" : "class";
  try {
    const { success } = await deps.revokeCollaboratorAccess(
      planType,
      row.planId,
      row.erasureRequest.userId,
    );
    return success ? null : "Collaborator Stream access not fully revoked";
  } catch (error_) {
    return errMsg(error_);
  }
}

async function recordErasureOutboxOutcome(params: {
  delegate: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  row: { id: string; attempts: number; erasureRequestId: string | null };
  error: string | null;
  errorLabel: string;
  now: Date;
  result: ModerationRetryResult;
  settledRequestIds: Set<string>;
  recovered?: "erasureRevocationsRecovered" | "accessRevocationsRecovered";
  /** Access rows only: the `nextRetryAt` read with the row, which every re-arm replaces. */
  generation?: { nextRetryAt: Date | null };
  /** Past the cap the row retries daily instead of giving up. */
  uncapped?: boolean;
}): Promise<void> {
  const { delegate, row, error, errorLabel, now, result, settledRequestIds } =
    params;
  const recovered = params.recovered ?? "erasureRevocationsRecovered";
  const attempts = row.attempts + 1;
  const pastCap = attempts >= MAX_ATTEMPTS;
  const gaveUp = Boolean(error) && pastCap && !params.uncapped;
  const retryAt = pastCap
    ? new Date(now.getTime() + PAST_CAP_RETRY_MS)
    : nextRetryAt(attempts, now);
  const data = error
    ? {
        status: "FAILED" as const,
        attempts,
        lastError: error,
        nextRetryAt: gaveUp ? null : retryAt,
      }
    : { status: "SUCCEEDED" as const, attempts, completedAt: now };
  if (params.generation) {
    const { count } = await prisma.streamRevocationRetry.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        nextRetryAt: params.generation.nextRetryAt,
      },
      data,
    });
    if (count === 0) {
      // A writer re-armed the row during this attempt; its new revocation stays owed.
      console.warn(
        JSON.stringify({ event: "access_revocation_rearmed", rowId: row.id }),
      );
      return;
    }
  } else {
    await delegate.update({ where: { id: row.id }, data });
  }
  if (error) {
    if (gaveUp) {
      result.gaveUp++;
      runFailures.add(
        "erasure-retry-gave-up",
        new Error(`${errorLabel} retry gave up`),
        { rowId: row.id, attempts, lastError: error },
        { level: "error" },
      );
    } else {
      result.stillFailing++;
      if (attempts === MAX_ATTEMPTS) {
        runFailures.add(
          "revocation-past-cap",
          new Error(`${errorLabel} retry past its attempt cap; retrying daily`),
          { rowId: row.id, attempts, lastError: error },
          { level: "error" },
        );
      }
    }
    result.errors.push(`${errorLabel} ${row.id}: ${error}`);
  } else {
    result[recovered]++;
    if (row.erasureRequestId) {
      settledRequestIds.add(row.erasureRequestId);
    }
  }
}

function canStartRevocationRow(
  kind: StreamRevocationKind,
  runDeadlineMs: number,
): boolean {
  const remainingMs = runDeadlineMs - Date.now();
  if (remainingMs <= 0) return false;
  const isSeatKind =
    kind === "SEAT_ACCESS_REVOKE" ||
    kind === "REFUND_ACCESS_REVOKE" ||
    kind === "CONDUCT_CALL_BLOCK";
  return !isSeatKind || remainingMs >= MIN_SEAT_REVOCATION_SLICE_MS;
}

type RevocationDrainRow = {
  kind: StreamRevocationKind;
  planType: CollaboratorType | null;
  planId: string;
  userId: string | null;
  counterpartUserId: string | null;
  createdAt: Date;
  erasureRequest: { userId: string } | null;
};

type RevocationDrainDeps = Parameters<typeof executeErasureRevocationRow>[1] & {
  redriveAccessRevocation: (
    row: AccessRevocationRow,
    opts: { deadlineMs?: number },
  ) => Promise<string | null>;
};

async function redriveRevocationRow(
  row: RevocationDrainRow,
  deps: RevocationDrainDeps,
  runDeadlineMs: number,
): Promise<string | null> {
  const { kind } = row;
  if (kind === "ERASURE_REVOKE") {
    return row.erasureRequest
      ? executeErasureRevocationRow(
          { ...row, erasureRequest: row.erasureRequest },
          deps,
        )
      : "Erasure retry has no erasure request";
  }
  if (!row.userId) return `${kind} retry has no user`;
  return deps
    .redriveAccessRevocation(
      { ...row, kind, userId: row.userId },
      { deadlineMs: runDeadlineMs },
    )
    .catch((error_: unknown) => errMsg(error_));
}

/**
 * Stops starting rows at `runDeadlineMs`, and before a seat, refund or block row once
 * less than its minimum slice is left; an unstarted row stays due for the next run.
 */
async function drainErasureRevocations(
  result: ModerationRetryResult,
  limit: number,
  settledRequestIds: Set<string>,
  runDeadlineMs: number,
): Promise<void> {
  if (!prisma.streamRevocationRetry?.findMany) return;
  const now = new Date();
  // #1593 — the outbox `scrubUser` writes inside its own transaction; a row
  // is owed until SUCCEEDED, and FAILED rows wait out their backoff slot.
  const rows = await prisma.streamRevocationRetry.findMany({
    where: streamRevocationDueWhere(now),
    select: {
      id: true,
      kind: true,
      erasureRequestId: true,
      userId: true,
      counterpartUserId: true,
      planType: true,
      planId: true,
      attempts: true,
      nextRetryAt: true,
      createdAt: true,
      erasureRequest: { select: { userId: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (rows.length === 0) return;

  const { STREAM_PRINCIPAL_PLAN_ID_PREFIX, eraseStreamPrincipalFootprint } =
    await import("@/lib/compliance/erasure/scrub-user");
  const { revokeCollaboratorAccess } =
    await import("@/lib/collaborators/service");
  const { redriveAccessRevocation } =
    await import("@/lib/stream/access-revocation");
  const deps = {
    principalPrefix: STREAM_PRINCIPAL_PLAN_ID_PREFIX,
    eraseStreamPrincipalFootprint,
    revokeCollaboratorAccess,
    redriveAccessRevocation,
  };
  for (const row of rows) {
    if (!canStartRevocationRow(row.kind, runDeadlineMs)) return;
    const isErasure = row.kind === "ERASURE_REVOKE";
    await recordErasureOutboxOutcome({
      delegate: prisma.streamRevocationRetry,
      row,
      error: await redriveRevocationRow(row, deps, runDeadlineMs),
      errorLabel: isErasure ? "erasure-revoke" : "access-revoke",
      now,
      result,
      settledRequestIds,
      recovered: isErasure
        ? "erasureRevocationsRecovered"
        : "accessRevocationsRecovered",
      ...(isErasure ? {} : { generation: { nextRetryAt: row.nextRetryAt } }),
      uncapped: isUncappedRevocationKind(row.kind),
    });
  }
}

type RazorpayRetryPayload = {
  customerId?: string | null;
  payoutAccounts?: {
    razorpayContactId: string | null;
    razorpayFundAccId: string | null;
  }[];
};

async function drainVendorErasureRetries(
  result: ModerationRetryResult,
  limit: number,
  settledRequestIds: Set<string>,
  streamReady: boolean,
): Promise<void> {
  if (!prisma.vendorErasureRetry?.findMany) return;
  const now = new Date();
  // Unattemptable STREAM rows are counted, not fetched, so they cannot fill the page ahead of other vendors.
  if (!streamReady) {
    result.streamUnconfigured += await prisma.vendorErasureRetry.count({
      where: { ...vendorErasureDueWhere(now), vendor: "STREAM" },
    });
  }
  const rows = await prisma.vendorErasureRetry.findMany({
    where: streamReady
      ? vendorErasureDueWhere(now)
      : { ...vendorErasureDueWhere(now), vendor: { not: "STREAM" } },
    select: {
      id: true,
      erasureRequestId: true,
      vendor: true,
      vendorRef: true,
      payload: true,
      attempts: true,
      erasureRequest: { select: { userId: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (rows.length === 0) return;

  const {
    eraseStreamPrincipalFootprint,
    offboardNotificationVendor,
    offboardPaymentVendors,
  } = await import("@/lib/compliance/erasure/scrub-user");

  for (const row of rows) {
    const targetUserId = row.vendorRef || row.erasureRequest.userId;
    let error: string | null = null;
    try {
      if (row.vendor === "NOVU") {
        const failures = await offboardNotificationVendor(targetUserId);
        if (failures.length > 0) error = failures.join("; ");
      } else if (row.vendor === "STREAM") {
        await eraseStreamPrincipalFootprint(targetUserId);
      } else if (row.vendor === "RAZORPAY") {
        const payload = (row.payload ?? {}) as RazorpayRetryPayload;
        const failures = await offboardPaymentVendors(prisma, {
          userId: targetUserId,
          razorpayCustomerId: payload.customerId ?? null,
          payoutAccounts: payload.payoutAccounts ?? [],
        });
        if (failures.length > 0) error = failures.join("; ");
      }
    } catch (error_) {
      error = errMsg(error_);
    }

    await recordErasureOutboxOutcome({
      delegate: prisma.vendorErasureRetry,
      row,
      error,
      errorLabel: `vendor-erasure ${row.vendor.toLowerCase()}`,
      now,
      result,
      settledRequestIds,
    });
  }
}

async function finalizeCompletedErasureRequests(
  settledRequestIds: Set<string>,
): Promise<void> {
  if (settledRequestIds.size === 0 || !prisma.erasureRequest) return;
  const now = new Date();
  for (const erasureRequestId of settledRequestIds) {
    const pendingFilter = {
      where: {
        erasureRequestId,
        status: { in: ["PENDING" as const, "FAILED" as const] },
      },
    };
    const pendingStream =
      (await prisma.streamRevocationRetry?.count?.(pendingFilter)) ?? 0;
    const pendingVendor =
      (await prisma.vendorErasureRetry?.count?.(pendingFilter)) ?? 0;
    if (pendingStream > 0 || pendingVendor > 0) continue;

    await prisma.erasureRequest.updateMany?.({
      where: { id: erasureRequestId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: now },
    });
  }
}

type Budget = { maxAttempts: number; giveUpOlderThan: Date };

async function retryOne(
  row: ActionRow,
  summary: SideEffectSummary,
  budget: Budget,
  result: ModerationRetryResult,
): Promise<void> {
  const attempts = summary.streamAttempts ?? 1;

  if (
    attempts >= budget.maxAttempts ||
    row.createdAt < budget.giveUpOlderThan
  ) {
    await cap(row, summary, result, "out of retry budget");
    return;
  }

  let applicable: boolean;
  try {
    applicable = await stillApplicable(row);
  } catch (error) {
    result.stillFailing++;
    result.errors.push(`${row.id}: ${errMsg(error)}`);
    return;
  }
  if (!applicable) {
    // Not a failure and not a success: the enforcement was reversed while the
    // Stream step was still owed, so there is nothing left to enforce.
    summary.stream = "skipped";
    summary.errors = appendNote(
      summary.errors,
      "stream: not retried — the ban was lifted before the retry ran",
    );
    await writeSummary(row.id, summary).catch(captureRetryError);
    result.skipped++;
    return;
  }

  try {
    if (row.actionType === "USER_REINSTATED") {
      await restoreStreamAccess(row.report.targetUserId);
    } else {
      await applyStreamEnforcement(row.actionType, reportRefOf(row));
    }
    summary.stream = "ok";
    summary.streamAttempts = attempts + 1;
    await writeSummary(row.id, summary);
    result.recovered++;
    console.log(`✅ Re-drove moderation enforcement for action ${row.id}`);
  } catch (error) {
    summary.stream = "failed";
    summary.streamAttempts = attempts + 1;
    summary.errors = appendNote(
      summary.errors,
      `${streamErrorPrefix(row.actionType)}: ${errMsg(error)} (attempt ${attempts + 1})`,
    );
    await writeSummary(row.id, summary).catch(captureRetryError);
    result.stillFailing++;
    result.errors.push(`${row.id}: ${errMsg(error)}`);
  }
}

/**
 * #1580 — re-run `revokeCollaboratorAccess` for every plan the action flipped.
 * Always applicable: the rows are REMOVED whatever became of the ban, and the
 * Stream removal is idempotent. Shares the attempt and age budget above.
 */
async function retryCollaboratorRevocation(
  row: ActionRow,
  summary: SideEffectSummary,
  budget: Budget,
  result: ModerationRetryResult,
): Promise<void> {
  const attempts = summary.collaboratorRevocationAttempts ?? 1;
  const plans = summary.collaborationsRemoved ?? [];

  if (
    attempts >= budget.maxAttempts ||
    row.createdAt < budget.giveUpOlderThan
  ) {
    summary.collaboratorRevocation = "gave_up";
    summary.errors = appendNote(
      summary.errors,
      "collaborator-revoke: gave up — out of retry budget",
    );
    await writeSummary(row.id, summary).catch(captureRetryError);
    result.gaveUp++;
    result.errors.push(`${row.id}: collaborator-revoke gave up`);
    runFailures.add(
      "collaborator-revocation-gave-up",
      new Error("Collaborator revocation gave up"),
      { actionId: row.id, actionType: row.actionType },
      { level: "error" },
    );
    return;
  }

  // Lazy, as in side-effects.ts: the service pulls Stream and Novu.
  const { revokeCollaboratorAccess } =
    await import("@/lib/collaborators/service");
  const failed: string[] = [];
  for (const { planType, planId } of plans) {
    try {
      const { success } = await revokeCollaboratorAccess(
        planType,
        planId,
        row.report.targetUserId,
      );
      if (!success) failed.push(`${planType}:${planId}`);
    } catch (error) {
      failed.push(`${planType}:${planId} (${errMsg(error)})`);
    }
  }

  summary.collaboratorRevocationAttempts = attempts + 1;
  if (failed.length === 0) {
    summary.collaboratorRevocation = "ok";
    await writeSummary(row.id, summary);
    result.collaboratorRecovered++;
    console.log(`✅ Re-drove collaborator revocation for action ${row.id}`);
    return;
  }
  summary.collaboratorRevocation = "failed";
  summary.errors = appendNote(
    summary.errors,
    `collaborator-revoke: ${failed.join(", ")} (attempt ${attempts + 1})`,
  );
  await writeSummary(row.id, summary).catch(captureRetryError);
  result.stillFailing++;
  result.errors.push(`${row.id}: collaborator-revoke ${failed.join(", ")}`);
}

async function cap(
  row: ActionRow,
  summary: SideEffectSummary,
  result: ModerationRetryResult,
  reason: string,
): Promise<void> {
  summary.stream = "gave_up";
  summary.errors = appendNote(
    summary.errors,
    `${streamErrorPrefix(row.actionType)}: gave up — ${reason}`,
  );
  await writeSummary(row.id, summary).catch(captureRetryError);
  result.gaveUp++;
  result.errors.push(`${row.id}: gave up — ${reason}`);
  // A capped row means an account is enforced in the database and unenforced on
  // Stream, indefinitely. That needs a human, so it pages.
  runFailures.add(
    "enforcement-gave-up",
    new Error("Moderation enforcement gave up"),
    { actionId: row.id, actionType: row.actionType },
    { level: "error" },
  );
}

// Keep the whole attempt history rather than overwriting: which attempt started
// failing, and how the message changed, is what tells an operator whether this
// is an outage or a permanently bad row.
function appendNote(errors: string[] | undefined, note: string): string[] {
  return [...(errors ?? []), note];
}

function captureRetryError(error: unknown): void {
  runFailures.add("write-summary", error);
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
