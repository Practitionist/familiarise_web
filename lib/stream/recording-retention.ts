/**
 * Platform recording retention: one pure deadline rule plus the daily
 * `expire-recordings` job that applies it and deletes the stored assets.
 */

import {
  OrgAuditCategory,
  Prisma,
  RecordingListingStatus,
  RecordingPurchaseStatus,
  RecordingStatus,
  RecordingStorageType,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { reportSentryMessage } from "@/lib/observability/report";
import { streamLogger } from "@/lib/stream-logger";
import { deleteRecordingAssets } from "@/lib/stream/recording-storage";
import { RecordingService } from "@/lib/stream/recording-service";
import { mapBounded } from "@/lib/stream/batch";
import { streamCopyExpiresAt } from "@/lib/stream/recording-utils";
import { RECORDING_RETENTION_SCHEDULE } from "@/lib/stream/recording-retention-schedule";

const DAY_MS = 24 * 60 * 60 * 1000;
const STREAM_REFRESH_WINDOW_DAYS = 15;
const ONE_TO_ONE_RETENTION_DAYS = RECORDING_RETENTION_SCHEDULE.oneToOneDays;
const SUBSCRIPTION_RETENTION_DAYS =
  RECORDING_RETENTION_SCHEDULE.subscriptionDays;
const GROUP_RETENTION_DAYS = RECORDING_RETENTION_SCHEDULE.groupDays;
/** Floor of the owner-set org cap; bounds which rows are worth scanning. */
export const MIN_ORG_RETENTION_DAYS = 7;
const DEFAULT_EXPIRE_LIMIT = 200;
const SCAN_PAGE_SIZE = 200;
const MAX_SCANNED_PER_RUN = 5_000;
/** Stream's copy outlives the size-verified R2 copy by a day, the window in which a bad copy can still be re-pulled. */
const STREAM_COPY_DELETE_DELAY_MS = DAY_MS;
const STREAM_COPY_DELETE_LIMIT = 50;
const LIVE_PURCHASE_STATUSES: RecordingPurchaseStatus[] = [
  RecordingPurchaseStatus.PENDING,
  RecordingPurchaseStatus.SUCCEEDED,
];
/** Live, unpublished and unbought: the only rows retention may expire. */
const retainableWhere = {
  status: { in: [RecordingStatus.READY, RecordingStatus.AVAILABLE] },
  listingStatus: { not: RecordingListingStatus.PUBLISHED },
  purchases: { none: { status: { in: LIVE_PURCHASE_STATUSES } } },
} satisfies Prisma.RecordingWhereInput;

/** What the recording's session was; end dates in the future mean "still running". */
type RetentionSession =
  | { kind: "CONSULTATION"; sessionEndedAt: Date }
  | { kind: "TRIAL"; sessionEndedAt: Date }
  | { kind: "SUBSCRIPTION"; subscriptionEndsAt: Date }
  | { kind: "WEBINAR"; sessionEndedAt: Date }
  | { kind: "CLASS"; lastSessionEndsAt: Date };

export interface RetentionInput {
  now: Date;
  recordedAt: Date;
  /** Null when the recording's appointment cannot be resolved. */
  session: RetentionSession | null;
  published: boolean;
  /** Any PENDING or SUCCEEDED replay purchase. */
  hasLivePurchase: boolean;
  /** The org's cap; pass null for personal recordings. */
  orgRetentionDays: number | null;
}

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

function platformDeadline(input: RetentionInput): Date | null {
  const { session, now } = input;
  if (!session) return addDays(input.recordedAt, ONE_TO_ONE_RETENTION_DAYS);
  switch (session.kind) {
    case "CONSULTATION":
    case "TRIAL":
      return addDays(session.sessionEndedAt, ONE_TO_ONE_RETENTION_DAYS);
    case "SUBSCRIPTION":
      return session.subscriptionEndsAt > now
        ? null
        : addDays(session.subscriptionEndsAt, SUBSCRIPTION_RETENTION_DAYS);
    case "WEBINAR":
      return addDays(session.sessionEndedAt, GROUP_RETENTION_DAYS);
    case "CLASS":
      return session.lastSessionEndsAt > now
        ? null
        : addDays(session.lastSessionEndsAt, GROUP_RETENTION_DAYS);
  }
}

/**
 * When a recording is deleted, or null for never. Published or bought replays
 * are exempt; an org cap can only shorten the platform schedule.
 */
export function recordingRetentionDeadline(input: RetentionInput): Date | null {
  if (input.published || input.hasLivePurchase) return null;
  const platform = platformDeadline(input);
  if (input.orgRetentionDays === null) return platform;
  const cap = addDays(input.recordedAt, input.orgRetentionDays);
  return platform && platform < cap ? platform : cap;
}

const subscriptionEndSelect = {
  id: true,
  schedulingPeriodEndsAt: true,
  cancelledAt: true,
} satisfies Prisma.SubscriptionSelect;

type SubscriptionEnd = Prisma.SubscriptionGetPayload<{
  select: typeof subscriptionEndSelect;
}>;

const endOf = (sub: SubscriptionEnd): Date =>
  sub.cancelledAt && sub.cancelledAt < sub.schedulingPeriodEndsAt
    ? sub.cancelledAt
    : sub.schedulingPeriodEndsAt;

/** A renewal continues the subscription, so its end is the last renewal's end. */
async function subscriptionChainEnd(start: SubscriptionEnd): Promise<Date> {
  let current = start;
  for (let hop = 0; hop < 60; hop++) {
    const next = await prisma.subscription.findUnique({
      where: { renewedFromSubscriptionId: current.id },
      select: subscriptionEndSelect,
    });
    if (!next) break;
    current = next;
  }
  return endOf(current);
}

/** Occurrences that still run; a class's last one sets its retention clock. */
const liveOccurrenceWhere = {
  deletedAt: null,
  hostCancelledAt: null,
  voidedAt: null,
  isTentative: false,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

const candidateSelect = {
  id: true,
  recordedAt: true,
  organizationId: true,
  organization: { select: { streamRecordingRetentionDays: true } },
  meeting: {
    select: {
      endedAt: true,
      occurrence: {
        select: {
          endsAt: true,
          appointment: {
            select: {
              consultationId: true,
              webinarId: true,
              classId: true,
              subscription: { select: subscriptionEndSelect },
              trial: { select: { id: true } },
              occurrences: {
                where: liveOccurrenceWhere,
                orderBy: { endsAt: "desc" },
                take: 1,
                select: { endsAt: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.RecordingSelect;

type Candidate = Prisma.RecordingGetPayload<{
  select: typeof candidateSelect;
}>;

/** Recordings of one subscription share its renewal chain, so a page walks each chain once. */
function cachedChainEnd(
  start: SubscriptionEnd,
  cache: Map<string, Promise<Date>>,
): Promise<Date> {
  const hit = cache.get(start.id);
  if (hit) return hit;
  const end = subscriptionChainEnd(start);
  cache.set(start.id, end);
  return end;
}

async function resolveSession(
  candidate: Candidate,
  chainEnds = new Map<string, Promise<Date>>(),
): Promise<RetentionSession | null> {
  const occurrence = candidate.meeting.occurrence;
  const appointment = occurrence.appointment;
  const sessionEndedAt = candidate.meeting.endedAt ?? occurrence.endsAt;
  if (appointment.webinarId) return { kind: "WEBINAR", sessionEndedAt };
  if (appointment.classId) {
    return {
      kind: "CLASS",
      lastSessionEndsAt: appointment.occurrences[0]?.endsAt ?? sessionEndedAt,
    };
  }
  if (appointment.subscription) {
    return {
      kind: "SUBSCRIPTION",
      subscriptionEndsAt: await cachedChainEnd(
        appointment.subscription,
        chainEnds,
      ),
    };
  }
  // A trial is a single 1:1 session, whatever it converted into.
  if (appointment.trial) return { kind: "TRIAL", sessionEndedAt };
  if (appointment.consultationId) {
    return { kind: "CONSULTATION", sessionEndedAt };
  }
  return null;
}

/** What a recording's "kept until" label says; computed by the same rule the sweep applies. */
export type RecordingRetentionLabel =
  { kind: "DATE"; until: Date } | { kind: "WHILE_ACTIVE" } | { kind: "NEVER" };

/** Retention labels for a page of recordings, keyed by recording id. */
export async function recordingRetentionLabels(
  recordingIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, RecordingRetentionLabel>> {
  const labels = new Map<string, RecordingRetentionLabel>();
  if (recordingIds.length === 0) return labels;
  const rows = await prisma.recording.findMany({
    where: { id: { in: [...recordingIds] } },
    select: {
      ...candidateSelect,
      listingStatus: true,
      purchases: {
        where: { status: { in: LIVE_PURCHASE_STATUSES } },
        select: { id: true },
        take: 1,
      },
    },
  });
  const chainEnds = new Map<string, Promise<Date>>();
  for (const row of rows) {
    const published = row.listingStatus === RecordingListingStatus.PUBLISHED;
    const hasLivePurchase = row.purchases.length > 0;
    if (published || hasLivePurchase) {
      labels.set(row.id, { kind: "NEVER" });
      continue;
    }
    const until = recordingRetentionDeadline({
      now,
      recordedAt: row.recordedAt,
      session: await resolveSession(row, chainEnds),
      published,
      hasLivePurchase,
      orgRetentionDays: row.organizationId
        ? (row.organization?.streamRecordingRetentionDays ?? null)
        : null,
    });
    labels.set(
      row.id,
      until ? { kind: "DATE", until } : { kind: "WHILE_ACTIVE" },
    );
  }
  return labels;
}

interface ExpireRecordingsResult {
  success: boolean;
  scanned: number;
  lapsed: number;
  expired: number;
  cleaned: number;
  streamCopiesDeleted: number;
  failed: number;
  errors: string[];
}

type RescueOutcome =
  | { kind: "refreshed" | "absent" | "unresolved" }
  | { kind: "failed"; error: string };

/** Refresh a lapsed READY row's URL, or report whether Stream confirmed the copy gone. */
async function rescueLapsedStreamRecording(
  row: { id: string; streamCallId: string; streamRecordingId: string | null },
  now: Date,
): Promise<RescueOutcome> {
  const listing = await RecordingService.getCallRecordingsFromStream(
    row.streamCallId,
  );
  if (listing.status === "unavailable") {
    return { kind: "failed", error: listing.error };
  }
  if (listing.status === "call-not-found") return { kind: "absent" };

  const { recordings } = listing;
  // Match by filename when known; without one, only a sole segment is ours.
  const match = row.streamRecordingId
    ? recordings.find((r) => r.filename === row.streamRecordingId)
    : recordings.length === 1
      ? recordings[0]
      : undefined;
  if (!match) {
    return row.streamRecordingId || recordings.length === 0
      ? { kind: "absent" }
      : { kind: "unresolved" };
  }
  if (!match.url) return { kind: "unresolved" };

  const computedExpiry = streamCopyExpiresAt(new Date(match.end_time));
  await prisma.recording.updateMany({
    where: {
      id: row.id,
      status: RecordingStatus.READY,
      storageType: RecordingStorageType.STREAM_S3,
    },
    data: {
      recordingUrl: match.url,
      streamUrlExpiresAt:
        computedExpiry > now ? computedExpiry : addDays(now, 1),
    },
  });
  return { kind: "refreshed" };
}

/**
 * READY rows whose Stream URL lapsed before the R2 copy finished. Inside the
 * refresh window a row expires only when Stream confirms the copy is gone; a
 * failed read leaves it READY for the next run. Older rows are past Stream's
 * 14-day retention, and a row with no call id has nothing to ask.
 */
async function expireLapsedCopies(
  now: Date,
  result: ExpireRecordingsResult,
  failedIds: string[],
): Promise<void> {
  const refreshCutoff = addDays(now, -STREAM_REFRESH_WINDOW_DAYS);
  const lapsedWhere = {
    status: RecordingStatus.READY,
    storageType: RecordingStorageType.STREAM_S3,
    streamUrlExpiresAt: { lt: now },
  } satisfies Prisma.RecordingWhereInput;

  const recentLapsed = await prisma.recording.findMany({
    where: {
      ...lapsedWhere,
      recordedAt: { gte: refreshCutoff },
      streamCallId: { not: null },
    },
    orderBy: [{ streamUrlExpiresAt: "asc" }, { id: "asc" }],
    take: SCAN_PAGE_SIZE,
    select: { id: true, streamCallId: true, streamRecordingId: true },
  });

  const outcomes = await mapBounded(recentLapsed, async (row) => {
    try {
      return row.streamCallId
        ? await rescueLapsedStreamRecording(
            { ...row, streamCallId: row.streamCallId },
            now,
          )
        : ({ kind: "absent" } as const);
    } catch (error) {
      return { kind: "failed", error: errorText(error) } as const;
    }
  });

  const absentIds: string[] = [];
  outcomes.forEach((outcome, i) => {
    const id = recentLapsed[i].id;
    if (outcome.kind === "absent") absentIds.push(id);
    if (outcome.kind === "failed") {
      result.failed++;
      failedIds.push(id);
      result.errors.push(`lapsed recording=${id}: ${outcome.error}`);
    }
  });

  const lapsed = await prisma.recording.updateMany({
    where: {
      ...lapsedWhere,
      OR: [
        { recordedAt: { lt: refreshCutoff } },
        { streamCallId: null },
        ...(absentIds.length > 0 ? [{ id: { in: absentIds } }] : []),
      ],
    },
    data: {
      status: RecordingStatus.EXPIRED,
      recordingUrl: "",
      removedAt: now,
      removalReason: "COPY_LAPSED",
    },
  });
  result.lapsed = lapsed.count;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Rows that can be due by age alone: the platform schedule (365 days for
 * group sessions, and never for a class with sessions still ahead) or the
 * row's org cap, whichever is shorter.
 */
async function dueScanWhere(now: Date): Promise<Prisma.RecordingWhereInput> {
  const cutoff = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const olderThan = (days: number) => ({ lt: cutoff(days) });
  // One arm per distinct cap, not per org, keeps the predicate bounded.
  const caps = await prisma.organization.findMany({
    where: { streamRecordingRetentionDays: { not: null } },
    distinct: ["streamRecordingRetentionDays"],
    select: { streamRecordingRetentionDays: true },
  });
  return {
    ...retainableWhere,
    OR: [
      {
        recordedAt: olderThan(GROUP_RETENTION_DAYS),
        meeting: {
          occurrence: {
            appointment: {
              OR: [
                { class: { is: null } },
                {
                  occurrences: {
                    none: { ...liveOccurrenceWhere, endsAt: { gt: now } },
                  },
                },
              ],
            },
          },
        },
      },
      {
        recordedAt: olderThan(ONE_TO_ONE_RETENTION_DAYS),
        meeting: {
          occurrence: {
            appointment: { webinar: { is: null }, class: { is: null } },
          },
        },
      },
      // A cap is due at recordedAt + cap <= now, so its cutoff is inclusive.
      ...caps.flatMap(({ streamRecordingRetentionDays: days }) =>
        days === null
          ? []
          : [
              {
                organization: { is: { streamRecordingRetentionDays: days } },
                recordedAt: { lte: cutoff(days) },
              },
            ],
      ),
    ],
  };
}

async function isDue(candidate: Candidate, now: Date): Promise<boolean> {
  // Published and purchased rows are already excluded by retainableWhere.
  const deadline = recordingRetentionDeadline({
    now,
    recordedAt: candidate.recordedAt,
    session: await resolveSession(candidate),
    published: false,
    hasLivePurchase: false,
    orgRetentionDays: candidate.organizationId
      ? (candidate.organization?.streamRecordingRetentionDays ?? null)
      : null,
  });
  return deadline !== null && deadline <= now;
}

/** Append the page's due rows to `due` until it holds `limit`. */
async function collectDue(
  page: Candidate[],
  now: Date,
  limit: number,
  due: Candidate[],
): Promise<void> {
  for (const candidate of page) {
    if (due.length >= limit) return;
    if (await isDue(candidate, now)) due.push(candidate);
  }
}

/** Oldest first, so rows that are due sort ahead of the not-yet-due ones the scan cap would otherwise spend itself on. */
async function findDueRecordings(
  now: Date,
  limit: number,
  result: ExpireRecordingsResult,
): Promise<Candidate[]> {
  const due: Candidate[] = [];
  const where = await dueScanWhere(now);
  let cursor: string | undefined;
  while (due.length < limit && result.scanned < MAX_SCANNED_PER_RUN) {
    const page = await prisma.recording.findMany({
      where,
      select: candidateSelect,
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      take: SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    result.scanned += page.length;
    await collectDue(page, now, limit, due);
    if (page.length < SCAN_PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }
  return due;
}

/** A run that spends its whole scan budget may be leaving due rows unreached, so say so once. */
function reportScanSaturation(
  scanned: number,
  dueCount: number,
  limit: number,
): void {
  if (scanned < MAX_SCANNED_PER_RUN || dueCount >= limit) return;
  reportSentryMessage(
    `expire-recordings hit its ${MAX_SCANNED_PER_RUN}-row scan cap; due rows past it wait`,
    {
      subsystem: "stream",
      op: "expire-recordings",
      level: "warning",
      fingerprint: ["expire-recordings", "scan-cap"],
      extra: { scanned, due: dueCount },
    },
  );
}

/** CAS-expire one scope's due rows; org scopes write their audit row in the same transaction. */
async function expireGroup(
  organizationId: string | null,
  ids: string[],
): Promise<number> {
  const where: Prisma.RecordingWhereInput = {
    id: { in: ids },
    ...retainableWhere,
  };
  const data = {
    status: RecordingStatus.EXPIRED,
    recordingUrl: "",
    removedAt: new Date(),
    removalReason: "RETENTION" as const,
  };
  if (!organizationId) {
    return (await prisma.recording.updateMany({ where, data })).count;
  }
  return prisma.$transaction(async (tx) => {
    const expired = await tx.recording.updateManyAndReturn({
      where,
      data,
      select: { id: true },
    });
    if (expired.length > 0) {
      await tx.orgAuditLog.create({
        data: {
          organizationId,
          category: OrgAuditCategory.SYSTEM,
          action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_DELETED,
          description: `Expired ${expired.length} recording(s) past retention`,
          details: {
            recordingIds: expired.map((r) => r.id),
            count: expired.length,
          },
        },
      });
    }
    return expired.length;
  });
}

/**
 * Delete an EXPIRED row's stored assets, then clear its pointers. Stream's
 * copy is deleted too; its id stays when that call cannot be confirmed so the
 * daily sweep retries it. On R2 failure the pointers stay for the same reason.
 */
export async function purgeExpiredRecordingAssets(row: {
  id: string;
  storagePath: string | null;
  streamCallId: string | null;
  streamRecordingId: string | null;
}): Promise<{ success: boolean; error?: string }> {
  // Dynamic import breaks the retention -> service -> decline -> retention cycle.
  const { deleteStreamRecordingCopy } =
    await import("@/lib/stream/recording-stream-delete");
  const streamCopy = await deleteStreamRecordingCopy(row);
  const deleted = await deleteRecordingAssets(row);
  if (!deleted.success) return deleted;
  try {
    await prisma.recording.updateMany({
      where: { id: row.id, status: RecordingStatus.EXPIRED },
      data: {
        storagePath: null,
        previewClipUrl: null,
        previewClipStoragePath: null,
        previewClipDuration: null,
        previewTranscript: null,
        thumbnailUrl: null,
        ...(streamCopy.success ? { streamRecordingId: null } : {}),
      },
    });
  } catch (error) {
    // The objects are gone; a pointer the database refuses to clear is retried by the sweep.
    return {
      success: false,
      error: error instanceof Error ? error.message : "pointer clear failed",
    };
  }
  if (!streamCopy.success) {
    return {
      success: false,
      error: streamCopy.error ?? "Stream copy was not removed",
    };
  }
  return { success: true };
}

/** Delete stored assets of EXPIRED rows that still point at them, including Stream's copy. */
async function cleanExpiredAssets(
  limit: number,
  result: ExpireRecordingsResult,
  failedIds: string[],
): Promise<void> {
  const rows = await prisma.recording.findMany({
    where: {
      status: RecordingStatus.EXPIRED,
      OR: [
        { storagePath: { not: null } },
        { previewClipStoragePath: { not: null } },
        { thumbnailUrl: { not: null } },
        { streamRecordingId: { not: null } },
      ],
    },
    select: {
      id: true,
      storagePath: true,
      streamCallId: true,
      streamRecordingId: true,
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const row of rows) {
    const deleted = await purgeExpiredRecordingAssets(row);
    if (!deleted.success) {
      result.failed++;
      failedIds.push(row.id);
      result.errors.push(`recording=${row.id}: ${deleted.error}`);
      // Requeue behind the rest so a stuck row cannot pin the head of the scan.
      await prisma.recording.updateMany({
        where: { id: row.id, status: RecordingStatus.EXPIRED },
        data: { updatedAt: new Date() },
      });
      continue;
    }
    result.cleaned++;
  }
}

/**
 * Delete Stream's copy of rows whose R2 copy was size-verified (`transferredAt`)
 * at least a day ago. Clearing `recordingUrl` marks it done; rows transferred
 * before the refresh window are past Stream's own 14-day retention.
 */
async function deleteTransferredStreamCopies(
  now: Date,
  result: ExpireRecordingsResult,
  failedIds: string[],
): Promise<void> {
  const rows = await prisma.recording.findMany({
    where: {
      status: RecordingStatus.AVAILABLE,
      storageType: RecordingStorageType.PLATFORM,
      storagePath: { not: null },
      transferredAt: {
        lte: new Date(now.getTime() - STREAM_COPY_DELETE_DELAY_MS),
        gt: addDays(now, -STREAM_REFRESH_WINDOW_DAYS),
      },
      streamCallId: { not: null },
      streamRecordingId: { not: null },
      recordingUrl: { not: "" },
    },
    orderBy: [{ transferredAt: "asc" }, { id: "asc" }],
    take: STREAM_COPY_DELETE_LIMIT,
    select: {
      id: true,
      streamCallId: true,
      streamRecordingId: true,
      recordingUrl: true,
    },
  });
  if (rows.length === 0) return;
  // Dynamic import breaks the retention -> service -> decline -> retention cycle.
  const { deleteStreamRecordingCopy } =
    await import("@/lib/stream/recording-stream-delete");
  const outcomes = await mapBounded(
    rows,
    async (row): Promise<{ marked: number } | { error: string }> => {
      const deleted = await deleteStreamRecordingCopy(row);
      if (!deleted.success) return { error: deleted.error ?? "not deleted" };
      try {
        const marked = await prisma.recording.updateMany({
          where: {
            id: row.id,
            status: RecordingStatus.AVAILABLE,
            recordingUrl: row.recordingUrl,
          },
          data: { recordingUrl: "" },
        });
        return { marked: marked.count };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
  );
  outcomes.forEach((outcome, i) => {
    if ("marked" in outcome) {
      result.streamCopiesDeleted += outcome.marked;
      return;
    }
    result.failed++;
    failedIds.push(rows[i].id);
    result.errors.push(`stream copy recording=${rows[i].id}: ${outcome.error}`);
  });
}

async function expireRecordingsUnlocked(
  limit: number,
): Promise<ExpireRecordingsResult> {
  const now = new Date();
  const result: ExpireRecordingsResult = {
    success: true,
    scanned: 0,
    lapsed: 0,
    expired: 0,
    cleaned: 0,
    streamCopiesDeleted: 0,
    failed: 0,
    errors: [],
  };
  const failedIds: string[] = [];

  await expireLapsedCopies(now, result, failedIds);

  const due = await findDueRecordings(now, limit, result);
  reportScanSaturation(result.scanned, due.length, limit);
  const groups = new Map<string | null, string[]>();
  for (const candidate of due) {
    const ids = groups.get(candidate.organizationId) ?? [];
    ids.push(candidate.id);
    groups.set(candidate.organizationId, ids);
  }
  for (const [organizationId, ids] of groups) {
    try {
      result.expired += await expireGroup(organizationId, ids);
    } catch (error) {
      result.failed += ids.length;
      failedIds.push(...ids);
      result.errors.push(
        `org=${organizationId ?? "personal"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await cleanExpiredAssets(limit, result, failedIds);
  await deleteTransferredStreamCopies(now, result, failedIds);

  if (failedIds.length > 0) {
    result.success = false;
    reportSentryMessage(
      `expire-recordings left ${failedIds.length} recording(s) unfinished`,
      {
        subsystem: "stream",
        op: "expire-recordings",
        level: "warning",
        fingerprint: ["expire-recordings", "failures"],
        extra: {
          recordingIds: failedIds.slice(0, 100),
          errors: result.errors.slice(0, 20),
        },
      },
    );
  }
  streamLogger.info("expire-recordings finished", {
    scanned: result.scanned,
    lapsed: result.lapsed,
    expired: result.expired,
    cleaned: result.cleaned,
    streamCopiesDeleted: result.streamCopiesDeleted,
    failed: result.failed,
  });
  return result;
}

/** Daily: expire lapsed copies and recordings past retention, delete their assets, then Stream's copies of transferred rows. */
export async function expireRecordings(
  opts: { limit?: number } = {},
): Promise<ExpireRecordingsResult> {
  return withCronLock("expire-recordings", { failMode: "open" }, () =>
    expireRecordingsUnlocked(opts.limit ?? DEFAULT_EXPIRE_LIMIT),
  );
}
