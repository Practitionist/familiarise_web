import "dotenv/config";

import * as Sentry from "@sentry/nextjs";

import prisma from "../../lib/prisma";
import {
  getStreamChatClient,
  isExpectedStreamError,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "../../lib/stream-channel-ids";
import {
  chunk,
  pause,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "../../lib/stream/batch";
import {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
} from "../../lib/stream/channel-lifecycle";
import {
  endActiveStreamVideoCalls,
  queryOrgTaggedChannels,
} from "../../lib/stream/event-channel-service";
import {
  loadOrgStreamSurfaces,
  revokeMemberStreamAccess,
  STREAM_REVOCATION_RETRY_WINDOW_HOURS,
} from "../../lib/enterprise/member-removal";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import { deleteRecordingObject } from "../../lib/stream/recording-storage";
import { removeObjects } from "../../lib/supabase-storage-core";

const MAX_ORGS_PER_RUN = 100;
const MAX_REMOVED_MEMBERS_PER_RUN = 250;
const RECORDING_PREVIEWS_BUCKET = "recordings-previews";
const STREAM_ORG_WOUND_DOWN_ACTION = "STREAM_ORG_WOUND_DOWN";
const STREAM_ORG_RETENTION_COMPLETE_ACTION = "STREAM_ORG_RETENTION_COMPLETE";

export interface WindDownDeactivatedOrgsResult {
  orgsScanned: number;
  callsEnded: number;
  eventChannelsFrozen: number;
  dmChannelsFrozen: number;
  tokensRevoked: number;
  recordingsUnpublished: number;
  recordingsPurged: number;
  removedMembersDrained: number;
  errors: string[];
  success: boolean;
}

type DeactivatedOrgRow = {
  id: string;
  deletedAt: Date | null;
  updatedAt: Date;
  streamRecordingRetentionDays: number | null;
  auditLogs?: { action: string; createdAt: Date }[];
};

export async function windDownDeactivatedOrgs(): Promise<WindDownDeactivatedOrgsResult> {
  return withCronLock("wind-down-deactivated-orgs", { failMode: "open" }, () =>
    windDownDeactivatedOrgsUnlocked(),
  );
}

const DEACTIVATED_ORG_SELECT = {
  id: true,
  deletedAt: true,
  updatedAt: true,
  streamRecordingRetentionDays: true,
  auditLogs: {
    where: {
      action: {
        in: [
          "ORG_SOFT_DELETED",
          "STATUS_CHANGED",
          "DEACTIVATED",
          STREAM_ORG_WOUND_DOWN_ACTION,
        ],
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: 5,
    select: { action: true, createdAt: true },
  },
};

async function loadCandidateDeactivatedOrgs(
  now: Date,
): Promise<DeactivatedOrgRow[]> {
  const freshOrgs =
    ((await prisma.organization.findMany({
      where: {
        AND: [
          { OR: [{ status: "DEACTIVATED" }, { deletedAt: { not: null } }] },
          {
            auditLogs: {
              none: {
                action: {
                  in: [
                    STREAM_ORG_WOUND_DOWN_ACTION,
                    STREAM_ORG_RETENTION_COMPLETE_ACTION,
                  ],
                },
              },
            },
          },
        ],
      },
      select: DEACTIVATED_ORG_SELECT,
      take: MAX_ORGS_PER_RUN,
      orderBy: { id: "asc" },
    })) as DeactivatedOrgRow[]) ?? [];

  const remainingCapacity = MAX_ORGS_PER_RUN - freshOrgs.length;
  if (remainingCapacity <= 0) {
    return freshOrgs;
  }

  const defaultRetentionCutoff = new Date(
    now.getTime() - DEFAULT_RETENTION_DAYS * DAY_MS,
  );
  const woundDownOrgs =
    ((await prisma.organization.findMany({
      where: {
        AND: [
          { OR: [{ status: "DEACTIVATED" }, { deletedAt: { not: null } }] },
          {
            auditLogs: {
              some: { action: STREAM_ORG_WOUND_DOWN_ACTION },
              none: { action: STREAM_ORG_RETENTION_COMPLETE_ACTION },
            },
          },
          {
            OR: [
              { deletedAt: { lte: defaultRetentionCutoff } },
              { updatedAt: { lte: defaultRetentionCutoff } },
              { streamRecordingRetentionDays: { lt: DEFAULT_RETENTION_DAYS } },
            ],
          },
        ],
      },
      select: DEACTIVATED_ORG_SELECT,
      take: remainingCapacity,
      orderBy: { id: "asc" },
    })) as DeactivatedOrgRow[]) ?? [];

  const retentionReadyOrgs = woundDownOrgs.filter((org) => {
    const retentionDays =
      org.streamRecordingRetentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    return resolveDeactivatedAnchor(org) <= cutoff;
  });

  return [...freshOrgs, ...retentionReadyOrgs];
}

async function windDownDeactivatedOrgsUnlocked(): Promise<WindDownDeactivatedOrgsResult> {
  const result: WindDownDeactivatedOrgsResult = {
    orgsScanned: 0,
    callsEnded: 0,
    eventChannelsFrozen: 0,
    dmChannelsFrozen: 0,
    tokensRevoked: 0,
    recordingsUnpublished: 0,
    recordingsPurged: 0,
    removedMembersDrained: 0,
    errors: [],
    success: true,
  };

  if (!isStreamConfigured()) {
    result.errors.push("Stream is not configured — nothing to do");
    result.success = false;
    return result;
  }

  const now = new Date();
  const chat = getStreamChatClient();
  const orgs = await loadCandidateDeactivatedOrgs(now);

  result.orgsScanned = orgs.length;

  for (const org of orgs) {
    try {
      await windDownSingleOrg(chat, org, now, result);
    } catch (err) {
      result.errors.push(
        `org ${org.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await drainPendingMemberRemovals(now, result);

  if (result.errors.length > 0) {
    result.success = false;
  }

  return result;
}

function resolveDeactivatedAnchor(org: DeactivatedOrgRow): Date {
  if (org.deletedAt) return org.deletedAt;
  const auditEntry = (org.auditLogs ?? []).find(
    (log) => log.action !== STREAM_ORG_WOUND_DOWN_ACTION,
  );
  if (auditEntry?.createdAt) return auditEntry.createdAt;
  const woundDownEntry = (org.auditLogs ?? []).find(
    (log) => log.action === STREAM_ORG_WOUND_DOWN_ACTION,
  );
  return woundDownEntry?.createdAt ?? org.updatedAt;
}

async function endOrgActiveVideoCalls(
  orgId: string,
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  if (!prisma.meeting?.findMany) return;
  const activeCalls = await prisma.meeting.findMany({
    where: { organizationId: orgId, endedAt: null },
    select: { id: true, streamCallId: true },
  });

  const callsRes = await endActiveStreamVideoCalls(activeCalls, {
    now,
    endedReason: "org_deactivated",
    errorPrefix: `org ${orgId}`,
    useCircuitBreaker: true,
  });
  result.callsEnded += callsRes.callsEnded;
  result.errors.push(...callsRes.errors);
}

type EventFreezeTarget = {
  kind: "webinar" | "class";
  id: string;
  channelId: string;
};

async function freezeSingleEventTarget(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  item: EventFreezeTarget,
  stampedWebinarIds: string[],
  stampedClassIds: string[],
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  try {
    await withStreamCircuitBreaker(() =>
      chat
        .channel("team", item.channelId)
        .updatePartial({ set: { frozen: true } }),
    );
    result.eventChannelsFrozen++;
    if (item.kind === "webinar") stampedWebinarIds.push(item.id);
    else stampedClassIds.push(item.id);
  } catch (err) {
    if (isExpectedStreamError(err)) {
      if (item.kind === "webinar") stampedWebinarIds.push(item.id);
      else stampedClassIds.push(item.id);
    } else {
      result.errors.push(
        `org ${orgId} freeze ${item.channelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function freezeOrgEventChannels(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  webinarIds: string[],
  classIds: string[],
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  const eventTargets: EventFreezeTarget[] = [
    ...webinarIds.map((id) => ({
      kind: "webinar" as const,
      id,
      channelId: `${WEBINAR_PREFIX}${id}`,
    })),
    ...classIds.map((id) => ({
      kind: "class" as const,
      id,
      channelId: `${CLASS_PREFIX}${id}`,
    })),
  ];

  for (const [batchIdx, batch] of chunk(
    eventTargets,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) await pause(STREAM_BATCH_PAUSE_MS);
    const stampedWebinarIds: string[] = [];
    const stampedClassIds: string[] = [];

    await Promise.all(
      batch.map((item) =>
        freezeSingleEventTarget(
          chat,
          orgId,
          item,
          stampedWebinarIds,
          stampedClassIds,
          result,
        ),
      ),
    );

    if (stampedWebinarIds.length > 0 && prisma.webinar?.updateMany) {
      await prisma.webinar.updateMany({
        where: { id: { in: stampedWebinarIds } },
        data: { chatFrozenAt: now },
      });
    }
    if (stampedClassIds.length > 0 && prisma.class?.updateMany) {
      await prisma.class.updateMany({
        where: { id: { in: stampedClassIds } },
        data: { chatFrozenAt: now },
      });
    }
  }
}

async function collectAllOrgDmChannelIds(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  initialDmChannelIds: string[],
  result: WindDownDeactivatedOrgsResult,
): Promise<string[]> {
  const dmChannelIds = new Set<string>(initialDmChannelIds);
  try {
    const { channels: taggedChannels } = await queryOrgTaggedChannels(
      chat,
      orgId,
      { frozen: false },
    );
    for (const ch of taggedChannels) {
      if (ch.id && ch.type === "messaging") {
        dmChannelIds.add(ch.id);
      }
    }
  } catch (err) {
    if (!isExpectedStreamError(err)) {
      result.errors.push(
        `org ${orgId} queryChannelsPaged: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return Array.from(dmChannelIds);
}

async function freezeOrgDmChannels(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  dmChannelIds: string[],
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  for (const [batchIdx, batch] of chunk(
    dmChannelIds,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) await pause(STREAM_BATCH_PAUSE_MS);
    await Promise.all(
      batch.map(async (channelId) => {
        try {
          await withStreamCircuitBreaker(() =>
            chat
              .channel("messaging", channelId)
              .updatePartial({ set: { frozen: true } }),
          );
          result.dmChannelsFrozen++;
        } catch (err) {
          if (!isExpectedStreamError(err)) {
            result.errors.push(
              `org ${orgId} freeze dm ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );
  }
}

async function purgeSingleOrgRecording(
  orgId: string,
  rec: {
    id: string;
    storagePath: string | null;
    previewClipStoragePath: string | null;
  },
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  try {
    if (rec.previewClipStoragePath) {
      if (
        !(await removeObjects(RECORDING_PREVIEWS_BUCKET, [
          rec.previewClipStoragePath,
        ]))
      ) {
        throw new Error("Recording preview clip was not removed from storage");
      }
    }
    const del = rec.storagePath
      ? await deleteRecordingObject(rec.storagePath)
      : { success: true };
    if (!del.success) {
      result.errors.push(
        `org ${orgId} deleteRecordingObject ${rec.id}: ${del.error ?? "storage delete failed"}`,
      );
      return;
    }
    await prisma.recording.update({
      where: { id: rec.id },
      data: {
        status: "EXPIRED",
        storagePath: null,
        storageType: "STREAM_S3",
        previewClipUrl: null,
        previewClipStoragePath: null,
        previewClipDuration: null,
        thumbnailUrl: null,
        listingStatus: "UNPUBLISHED",
        unpublishedAt: now,
      },
    });
    result.recordingsPurged++;
  } catch (err) {
    result.errors.push(
      `org ${orgId} purge recording ${rec.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function purgeExpiredOrgRecordings(
  org: DeactivatedOrgRow,
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  if (!prisma.recording?.findMany) return;
  const retentionDays =
    org.streamRecordingRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const deactivatedAnchor = resolveDeactivatedAnchor(org);
  const retentionCutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const purgeErrorsBefore = result.errors.length;

  const expiredRecordings = await prisma.recording.findMany({
    where: {
      organizationId: org.id,
      status: { notIn: ["EXPIRED", "FAILED"] },
      purchases: { none: {} },
      ...(deactivatedAnchor <= retentionCutoff
        ? {}
        : { createdAt: { lte: retentionCutoff } }),
    },
    select: {
      id: true,
      storagePath: true,
      previewClipStoragePath: true,
    },
  });

  for (const rec of expiredRecordings) {
    await purgeSingleOrgRecording(org.id, rec, now, result);
  }

  if (
    deactivatedAnchor <= retentionCutoff &&
    result.errors.length === purgeErrorsBefore &&
    prisma.orgAuditLog?.create
  ) {
    await prisma.orgAuditLog.create({
      data: {
        organizationId: org.id,
        category: "SYSTEM",
        action: STREAM_ORG_RETENTION_COMPLETE_ACTION,
        description:
          "Deactivated organization Stream recording retention purge completed",
        details: { completedAt: now.toISOString() },
      },
    });
  }
}

async function windDownSingleOrg(
  chat: ReturnType<typeof getStreamChatClient>,
  org: DeactivatedOrgRow,
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  const alreadyWoundDown = (org.auditLogs ?? []).some(
    (log) => log.action === STREAM_ORG_WOUND_DOWN_ACTION,
  );
  const errorsBefore = result.errors.length;

  if (!alreadyWoundDown) {
    await endOrgActiveVideoCalls(org.id, now, result);

    const surfaces = await loadOrgStreamSurfaces(org.id, {
      onlyUnfrozen: true,
    });
    await freezeOrgEventChannels(
      chat,
      org.id,
      surfaces.webinarIds,
      surfaces.classIds,
      now,
      result,
    );

    const dmChannelIds = await collectAllOrgDmChannelIds(
      chat,
      org.id,
      surfaces.dmChannelIds,
      result,
    );
    await freezeOrgDmChannels(chat, org.id, dmChannelIds, result);

    if (prisma.recording?.updateMany) {
      const unpublished = await prisma.recording.updateMany({
        where: { organizationId: org.id, listingStatus: "PUBLISHED" },
        data: { listingStatus: "UNPUBLISHED", unpublishedAt: now },
      });
      result.recordingsUnpublished += unpublished.count;
    }

    if (result.errors.length === errorsBefore && prisma.orgAuditLog?.create) {
      await prisma.orgAuditLog.create({
        data: {
          organizationId: org.id,
          category: "SYSTEM",
          action: STREAM_ORG_WOUND_DOWN_ACTION,
          description:
            "Deactivated organization Stream calls ended and channels frozen",
          details: { woundDownAt: now.toISOString() },
        },
      });
    }
  }

  await purgeExpiredOrgRecordings(org, now, result);
}

async function loadRejoinedMemberKeys(
  uniquePairs: { userId: string; organizationId: string }[],
): Promise<Set<string>> {
  const rejoinedRows =
    (await prisma.membership.findMany({
      where: {
        status: { in: ["ACTIVE", "PENDING"] },
        OR: uniquePairs.map((p) => ({
          userId: p.userId,
          organizationId: p.organizationId,
        })),
      },
      select: { userId: true, organizationId: true },
    })) ?? [];
  return new Set(rejoinedRows.map((r) => `${r.userId}:${r.organizationId}`));
}

async function drainSingleRemovedMember(
  row: { userId: string; organizationId: string },
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  try {
    const outcome = await revokeMemberStreamAccess({
      userId: row.userId,
      orgId: row.organizationId,
    });
    if (outcome.complete) {
      result.removedMembersDrained++;
    } else {
      result.errors.push(
        `removed member ${row.userId}@${row.organizationId}: ${outcome.failures.join(", ")}`,
      );
    }
  } catch (err) {
    result.errors.push(
      `removed member ${row.userId}@${row.organizationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "stream", op: "wind-down-deactivated-orgs" } },
    );
  }
}

async function drainPendingMemberRemovals(
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  if (!prisma.membership?.findMany) return;
  const windowFrom = new Date(
    now.getTime() - STREAM_REVOCATION_RETRY_WINDOW_HOURS * 3_600_000,
  );
  const removedRows = await prisma.membership.findMany({
    where: {
      status: "REMOVED",
      updatedAt: { gte: windowFrom },
    },
    select: { userId: true, organizationId: true },
    take: MAX_REMOVED_MEMBERS_PER_RUN,
    orderBy: { updatedAt: "desc" },
  });
  if (!removedRows || removedRows.length === 0) return;

  const uniqueByKey = new Map<
    string,
    { userId: string; organizationId: string }
  >();
  for (const row of removedRows) {
    uniqueByKey.set(`${row.userId}:${row.organizationId}`, row);
  }
  const uniquePairs = Array.from(uniqueByKey.values());
  const rejoinedKeys = await loadRejoinedMemberKeys(uniquePairs);

  for (const row of uniquePairs) {
    if (rejoinedKeys.has(`${row.userId}:${row.organizationId}`)) continue;
    await drainSingleRemovedMember(row, result);
  }
}

if (require.main === module) {
  runJob("wind-down-deactivated-orgs", async () => {
    await abortIfMaintenance("wind-down-deactivated-orgs");
    try {
      const result = await windDownDeactivatedOrgs();
      console.log(JSON.stringify(result));
      if (!result.success) process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  });
}
