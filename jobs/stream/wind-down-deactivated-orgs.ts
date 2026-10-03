import "dotenv/config";

import * as Sentry from "@sentry/nextjs";

import prisma from "../../lib/prisma";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "../../lib/stream-channel-ids";
import { STREAM_CALL_TYPE, toCallId } from "../../lib/stream/call-cid";
import {
  chunk,
  pause,
  queryChannelsPaged,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "../../lib/stream/batch";
import {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
} from "../../lib/stream/channel-lifecycle";
import {
  loadOrgStreamSurfaces,
  revokeMemberStreamAccess,
  STREAM_REVOCATION_RETRY_WINDOW_HOURS,
} from "../../lib/enterprise/member-removal";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import {
  deleteRecordingObject,
  storageClient,
} from "../../lib/stream/recording-storage";

const MAX_ORGS_PER_RUN = 100;
const MAX_REMOVED_MEMBERS_PER_RUN = 250;
const RECORDING_PREVIEWS_BUCKET = "recordings-previews";

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

export async function windDownDeactivatedOrgs(): Promise<WindDownDeactivatedOrgsResult> {
  return withCronLock("wind-down-deactivated-orgs", { failMode: "open" }, () =>
    windDownDeactivatedOrgsUnlocked(),
  );
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

  if (prisma.meeting?.findMany) {
    const strandedHardDeletedCalls = await prisma.meeting.findMany({
      where: {
        endedAt: null,
        endedReason: "org_deleted",
      },
      select: { id: true, streamCallId: true },
      take: 250,
    });

    if (strandedHardDeletedCalls.length > 0) {
      try {
        const video = getStreamVideoClient().video;
        for (const call of strandedHardDeletedCalls) {
          let ended = false;
          try {
            await withStreamCircuitBreaker(() =>
              video.call(STREAM_CALL_TYPE, toCallId(call.streamCallId)).end(),
            );
            ended = true;
            result.callsEnded++;
          } catch (err) {
            if (isExpectedStreamError(err)) {
              ended = true;
            } else {
              result.errors.push(
                `stranded call ${call.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (ended) {
            await prisma.meeting.updateMany({
              where: { id: call.id, endedAt: null },
              data: { endedAt: now, endedReason: null },
            });
          }
        }
      } catch (err) {
        result.errors.push(
          `stranded call video client: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const orgs = await prisma.organization.findMany({
    where: {
      OR: [{ status: "DEACTIVATED" }, { deletedAt: { not: null } }],
    },
    select: {
      id: true,
      deletedAt: true,
      updatedAt: true,
      streamRecordingRetentionDays: true,
    },
    take: MAX_ORGS_PER_RUN,
    orderBy: { updatedAt: "desc" },
  });

  result.orgsScanned = orgs.length;

  for (const org of orgs) {
    await windDownSingleOrg(chat, org, now, result);
  }

  await drainPendingMemberRemovals(now, result);

  if (result.errors.length > 0) {
    result.success = false;
  }

  return result;
}

async function windDownSingleOrg(
  chat: ReturnType<typeof getStreamChatClient>,
  org: {
    id: string;
    deletedAt: Date | null;
    updatedAt: Date;
    streamRecordingRetentionDays: number | null;
  },
  now: Date,
  result: WindDownDeactivatedOrgsResult,
): Promise<void> {
  if (prisma.meeting?.findMany) {
    const activeCalls = await prisma.meeting.findMany({
      where: { organizationId: org.id, endedAt: null },
      select: { id: true, streamCallId: true },
    });

    if (activeCalls.length > 0) {
      try {
        const video = getStreamVideoClient().video;
        for (const call of activeCalls) {
          let ended = false;
          try {
            await withStreamCircuitBreaker(() =>
              video.call(STREAM_CALL_TYPE, toCallId(call.streamCallId)).end(),
            );
            ended = true;
            result.callsEnded++;
          } catch (err) {
            if (isExpectedStreamError(err)) {
              ended = true;
            } else {
              result.errors.push(
                `org ${org.id} call ${call.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (ended) {
            await prisma.meeting.updateMany({
              where: { id: call.id, endedAt: null },
              data: { endedAt: now, endedReason: "org_deactivated" },
            });
          }
        }
      } catch (err) {
        result.errors.push(
          `org ${org.id} video client: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const surfaces = await loadOrgStreamSurfaces(org.id, { onlyUnfrozen: true });
  const eventTargets: {
    kind: "webinar" | "class";
    id: string;
    channelId: string;
  }[] = [
    ...surfaces.webinarIds.map((id) => ({
      kind: "webinar" as const,
      id,
      channelId: `${WEBINAR_PREFIX}${id}`,
    })),
    ...surfaces.classIds.map((id) => ({
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
      batch.map(async (item) => {
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
              `org ${org.id} freeze ${item.channelId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
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

  const dmChannelIds = new Set<string>(surfaces.dmChannelIds);
  try {
    const { channels: taggedChannels } = await queryChannelsPaged((opts) =>
      chat.queryChannels(
        {
          organization_id: { $eq: org.id },
          frozen: false,
        },
        [{ last_message_at: -1 }],
        opts,
      ),
    );
    for (const ch of taggedChannels) {
      if (ch.id && ch.type === "messaging") {
        dmChannelIds.add(ch.id);
      }
    }
  } catch (err) {
    if (!isExpectedStreamError(err)) {
      result.errors.push(
        `org ${org.id} queryChannelsPaged: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const [batchIdx, batch] of chunk(
    Array.from(dmChannelIds),
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
              `org ${org.id} freeze dm ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );
  }

  if (prisma.membership?.findMany) {
    const memberships = await prisma.membership.findMany({
      where: {
        organizationId: org.id,
        status: { in: ["ACTIVE", "PENDING", "SUSPENDED"] },
      },
      select: { userId: true },
    });
    const memberIds = Array.from(new Set(memberships.map((m) => m.userId)));
    for (const [batchIdx, batch] of chunk(
      memberIds,
      STREAM_CONCURRENCY_LIMIT,
    ).entries()) {
      if (batchIdx > 0) await pause(STREAM_BATCH_PAUSE_MS);
      await Promise.all(
        batch.map(async (userId) => {
          try {
            await withStreamCircuitBreaker(() =>
              chat.revokeUserToken(userId, now),
            );
            result.tokensRevoked++;
          } catch (err) {
            if (!isExpectedStreamError(err)) {
              result.errors.push(
                `org ${org.id} revokeUserToken ${userId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }),
      );
    }
  }

  if (prisma.recording?.updateMany) {
    const unpublished = await prisma.recording.updateMany({
      where: { organizationId: org.id, listingStatus: "PUBLISHED" },
      data: { listingStatus: "UNPUBLISHED", unpublishedAt: now },
    });
    result.recordingsUnpublished += unpublished.count;
  }

  const retentionDays =
    org.streamRecordingRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const deactivatedAnchor = org.deletedAt ?? org.updatedAt;
  const retentionCutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  if (prisma.recording?.findMany) {
    const expiredRecordings = await prisma.recording.findMany({
      where: {
        organizationId: org.id,
        status: { notIn: ["EXPIRED", "FAILED"] },
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
      try {
        if (rec.previewClipStoragePath) {
          await storageClient.storage
            .from(RECORDING_PREVIEWS_BUCKET)
            .remove([rec.previewClipStoragePath]);
        }
        const del = rec.storagePath
          ? await deleteRecordingObject(rec.storagePath)
          : { success: true };
        if (!del.success) {
          result.errors.push(
            `org ${org.id} deleteRecordingObject ${rec.id}: ${del.error ?? "storage delete failed"}`,
          );
          continue;
        }
        await prisma.recording.update({
          where: { id: rec.id },
          data: {
            status: "EXPIRED",
            storageUrl: null,
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
          `org ${org.id} purge recording ${rec.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

  for (const row of removedRows) {
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
