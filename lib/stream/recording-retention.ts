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

const DAY_MS = 24 * 60 * 60 * 1000;
const ONE_TO_ONE_RETENTION_DAYS = 90;
const SUBSCRIPTION_RETENTION_DAYS = 90;
const GROUP_RETENTION_DAYS = 365;
/** Floor of the owner-set org cap; bounds which rows are worth scanning. */
export const MIN_ORG_RETENTION_DAYS = 7;
const DEFAULT_EXPIRE_LIMIT = 200;
const SCAN_PAGE_SIZE = 200;
const MAX_SCANNED_PER_RUN = 5_000;
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
              consultation: { select: { id: true } },
              webinar: { select: { id: true } },
              class: { select: { id: true } },
              subscription: { select: subscriptionEndSelect },
              trial: {
                select: {
                  convertedToSubscription: { select: subscriptionEndSelect },
                },
              },
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

async function resolveSession(
  candidate: Candidate,
): Promise<RetentionSession | null> {
  const occurrence = candidate.meeting.occurrence;
  const appointment = occurrence.appointment;
  const sessionEndedAt = candidate.meeting.endedAt ?? occurrence.endsAt;
  if (appointment.webinar) return { kind: "WEBINAR", sessionEndedAt };
  if (appointment.class) {
    return {
      kind: "CLASS",
      lastSessionEndsAt: appointment.occurrences[0]?.endsAt ?? sessionEndedAt,
    };
  }
  if (appointment.subscription) {
    return {
      kind: "SUBSCRIPTION",
      subscriptionEndsAt: await subscriptionChainEnd(appointment.subscription),
    };
  }
  if (appointment.trial) {
    const converted = appointment.trial.convertedToSubscription;
    return {
      kind: "SUBSCRIPTION",
      subscriptionEndsAt: converted
        ? await subscriptionChainEnd(converted)
        : sessionEndedAt,
    };
  }
  if (appointment.consultation) {
    return { kind: "CONSULTATION", sessionEndedAt };
  }
  return null;
}

interface ExpireRecordingsResult {
  success: boolean;
  scanned: number;
  lapsed: number;
  expired: number;
  cleaned: number;
  failed: number;
  errors: string[];
}

/** READY rows whose Stream copy lapsed before our copy existed. */
async function expireLapsedCopies(now: Date): Promise<number> {
  const lapsed = await prisma.recording.updateMany({
    where: {
      status: RecordingStatus.READY,
      storageType: RecordingStorageType.STREAM_S3,
      streamUrlExpiresAt: { lt: now },
    },
    data: { status: RecordingStatus.EXPIRED, recordingUrl: "" },
  });
  return lapsed.count;
}

/**
 * Rows that can be due by age alone: the platform schedule (365 days for
 * group sessions, and never for a class with sessions still ahead) or the
 * row's org cap, whichever is shorter.
 */
async function dueScanWhere(now: Date): Promise<Prisma.RecordingWhereInput> {
  const olderThan = (days: number) => ({
    lt: new Date(now.getTime() - days * DAY_MS),
  });
  const cappedOrgs = await prisma.organization.findMany({
    where: { streamRecordingRetentionDays: { not: null } },
    select: { id: true, streamRecordingRetentionDays: true },
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
      ...cappedOrgs.flatMap(({ id, streamRecordingRetentionDays: days }) =>
        days === null
          ? []
          : [{ organizationId: id, recordedAt: olderThan(days) }],
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
  const data = { status: RecordingStatus.EXPIRED, recordingUrl: "" };
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
 * Delete an EXPIRED row's stored assets, then clear its pointers. On failure
 * the pointers stay, so the daily sweep retries the delete.
 */
export async function purgeExpiredRecordingAssets(row: {
  id: string;
  storagePath: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const deleted = await deleteRecordingAssets(row);
  if (!deleted.success) return deleted;
  await prisma.recording.updateMany({
    where: { id: row.id, status: RecordingStatus.EXPIRED },
    data: {
      storagePath: null,
      previewClipUrl: null,
      previewClipStoragePath: null,
      previewClipDuration: null,
      thumbnailUrl: null,
    },
  });
  return { success: true };
}

/** Delete stored assets of EXPIRED rows that still point at them, then clear the pointers. */
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
      ],
    },
    select: { id: true, storagePath: true },
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
    failed: 0,
    errors: [],
  };
  const failedIds: string[] = [];

  result.lapsed = await expireLapsedCopies(now);

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
    failed: result.failed,
  });
  return result;
}

/** Daily: expire lapsed copies and recordings past retention, then delete their assets. */
export async function expireRecordings(
  opts: { limit?: number } = {},
): Promise<ExpireRecordingsResult> {
  return withCronLock("expire-recordings", { failMode: "open" }, () =>
    expireRecordingsUnlocked(opts.limit ?? DEFAULT_EXPIRE_LIMIT),
  );
}
