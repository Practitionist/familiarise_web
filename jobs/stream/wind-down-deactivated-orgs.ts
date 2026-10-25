import "dotenv/config";
import { z } from "zod";

import prisma from "../../lib/prisma";
import type { RunFailureReporter } from "../../lib/observability/run-failures";
import {
  reportSentryError,
  type ReportOpts,
} from "../../lib/observability/report";
import {
  getStreamChatClient,
  isExpectedStreamError,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import {
  CLASS_PREFIX,
  collabChannelId,
  WEBINAR_PREFIX,
} from "../../lib/stream-channel-ids";
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
} from "../../lib/stream/channel-administration";
import {
  loadOrgStreamSurfaces,
  revokeMemberStreamAccess,
  STREAM_REVOCATION_RETRY_WINDOW_HOURS,
  ORG_STREAM_SURFACE_LIMIT,
} from "../../lib/stream/org-access-revocation";
import { readJobCheckpoint, withCronLock } from "../../lib/cron/with-cron-lock";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import { purgeExpiredRecordingAssets } from "../../lib/stream/recording-retention";

const MAX_ORGS_PER_RUN = 2;
const MAX_REMOVED_MEMBERS_PER_RUN = 10;
const MAX_RECORDINGS_PER_ORG = 10;
const progressSchema = z.object({
  organization: z.string().nullable(),
  membership: z.string().nullable(),
});
type WindDownProgress = z.infer<typeof progressSchema>;
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
  checkpoint: string | null;
}

type DeactivatedOrgRow = {
  id: string;
  deletedAt: Date | null;
  updatedAt: Date;
  streamRecordingRetentionDays: number | null;
  auditLogs?: { action: string; createdAt: Date }[];
};

export async function windDownDeactivatedOrgs(): Promise<WindDownDeactivatedOrgsResult> {
  return withCronLock(
    "wind-down-deactivated-orgs",
    { failMode: "closed" },
    async () => {
      const failures = windDownFailureReporter();
      try {
        return await windDownDeactivatedOrgsUnlocked(failures);
      } finally {
        failures.flush();
      }
    },
  );
}

interface WindDownFailureReporter extends RunFailureReporter {
  deadlineMs: number;
}
function assertRunBudget(failures: WindDownFailureReporter): void {
  if (Date.now() >= failures.deadlineMs)
    throw new Error(
      "Stream wind-down time budget exhausted; unfinished work remains retryable",
    );
}
function windDownFailureReporter(): WindDownFailureReporter {
  let count = 0;
  let first: unknown;
  let billing = false;
  let expected = true;
  let level: NonNullable<ReportOpts["level"]> = "debug";
  const levels = ["debug", "log", "info", "warning", "error", "fatal"];
  const sample: Record<string, unknown>[] = [];
  return {
    deadlineMs: Date.now() + 5 * 60 * 1000,
    add(operation, error, context, opts) {
      count++;
      if (count === 1 || (!billing && context?.reason === "stream.billing"))
        first = error;
      billing ||= context?.reason === "stream.billing";
      expected &&= opts?.expected ?? false;
      const nextLevel = opts?.level ?? "error";
      if (levels.indexOf(nextLevel) > levels.indexOf(level)) level = nextLevel;
      if (sample.length < 10) sample.push({ ...context, operation });
    },
    flush() {
      if (!count) return;
      reportSentryError(first, {
        subsystem: "stream",
        op: "wind-down-deactivated-orgs",
        level,
        expected,
        ...(billing ? { tags: { reason: "stream.billing" } } : {}),
        fingerprint: ["stream", "wind-down-deactivated-orgs"],
        extra: { count, sample: [...sample] },
      });
      count = 0;
      first = undefined;
      billing = false;
      expected = true;
      level = "debug";
      sample.length = 0;
    },
  };
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
  after: string | null,
): Promise<DeactivatedOrgRow[]> {
  const freshOrgs =
    ((await prisma.organization.findMany({
      where: {
        ...(after ? { id: { gt: after } } : {}),
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
        ...(after ? { id: { gt: after } } : {}),
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

  const rows = [...freshOrgs, ...woundDownOrgs];
  return rows.length === 0 && after
    ? loadCandidateDeactivatedOrgs(now, null)
    : rows;
}

async function windDownDeactivatedOrgsUnlocked(
  failures: WindDownFailureReporter,
): Promise<WindDownDeactivatedOrgsResult> {
  const saved = await readJobCheckpoint("wind-down-deactivated-orgs");
  const progress = saved
    ? progressSchema.parse(JSON.parse(saved))
    : { organization: null, membership: null };
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
    checkpoint: saved,
  };

  if (!isStreamConfigured()) {
    result.errors.push("Stream is not configured — nothing to do");
    result.success = false;
    return result;
  }

  const now = new Date();
  const chat = getStreamChatClient();
  const orgs = await loadCandidateDeactivatedOrgs(now, progress.organization);

  for (const org of orgs) {
    if (Date.now() >= failures.deadlineMs) {
      result.errors.push("Organization slice deferred after time budget");
      break;
    }
    result.orgsScanned++;
    try {
      await windDownSingleOrg(chat, org, now, result, failures);
    } catch (err) {
      result.errors.push(
        `org ${org.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    progress.organization = org.id;
  }

  try {
    await drainPendingMemberRemovals(now, result, failures, progress);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  if (result.errors.length > 0) {
    result.success = false;
  }

  result.checkpoint = JSON.stringify(progress);
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
  failures: WindDownFailureReporter,
): Promise<void> {
  if (!prisma.meeting?.findMany) return;
  const activeCalls = await prisma.meeting.findMany({
    where: { organizationId: orgId, endedAt: null },
    select: { id: true, streamCallId: true },
    take: ORG_STREAM_SURFACE_LIMIT + 1,
  });
  if (activeCalls.length > ORG_STREAM_SURFACE_LIMIT)
    result.errors.push(`org ${orgId} active call scan truncated`);

  const callsRes = await endActiveStreamVideoCalls(
    activeCalls.slice(0, ORG_STREAM_SURFACE_LIMIT),
    {
      now,
      endedReason: "org_deactivated",
      errorPrefix: `org ${orgId}`,
      useCircuitBreaker: true,
      failures,
      deadlineMs: failures.deadlineMs,
    },
  );
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
  failures: WindDownFailureReporter,
): Promise<void> {
  try {
    await withStreamCircuitBreaker(
      () =>
        chat
          .channel("team", item.channelId)
          .updatePartial({ set: { frozen: true } }),
      undefined,
      failures,
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
  failures: WindDownFailureReporter,
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
    assertRunBudget(failures);
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
          failures,
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
  failures: WindDownFailureReporter,
): Promise<string[]> {
  const dmChannelIds = new Set<string>(initialDmChannelIds);

  const [orgWebinarPlans, orgClassPlans] = await Promise.all([
    prisma.webinarPlan?.findMany
      ? prisma.webinarPlan.findMany({
          where: {
            organizationId: orgId,
            collaborators: { some: { status: "ACCEPTED" } },
          },
          select: { id: true },
          take: ORG_STREAM_SURFACE_LIMIT + 1,
        })
      : Promise.resolve([]),
    prisma.classPlan?.findMany
      ? prisma.classPlan.findMany({
          where: {
            organizationId: orgId,
            collaborators: { some: { status: "ACCEPTED" } },
          },
          select: { id: true },
          take: ORG_STREAM_SURFACE_LIMIT + 1,
        })
      : Promise.resolve([]),
  ]);

  if (
    orgWebinarPlans.length > ORG_STREAM_SURFACE_LIMIT ||
    orgClassPlans.length > ORG_STREAM_SURFACE_LIMIT
  )
    result.errors.push(`org ${orgId} collaborator-plan scan truncated`);
  for (const plan of orgWebinarPlans.slice(0, ORG_STREAM_SURFACE_LIMIT)) {
    dmChannelIds.add(collabChannelId("webinar", plan.id));
  }
  for (const plan of orgClassPlans.slice(0, ORG_STREAM_SURFACE_LIMIT)) {
    dmChannelIds.add(collabChannelId("class", plan.id));
  }

  try {
    const { channels: taggedChannels, truncated } =
      await queryOrgTaggedChannels(
        chat,
        orgId,
        { frozen: false },
        { deadlineMs: failures.deadlineMs },
      );
    if (truncated) {
      result.errors.push(
        `org ${orgId} queryChannelsPaged: truncated after ${taggedChannels.length} channels; wind-down remains incomplete`,
      );
    }
    for (const ch of taggedChannels) {
      if (ch.id && ch.type === "messaging") {
        dmChannelIds.add(ch.id);
      }
    }
  } catch (err) {
    result.errors.push(
      `org ${orgId} queryChannelsPaged: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return Array.from(dmChannelIds);
}

async function freezeOrgDmChannels(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  dmChannelIds: string[],
  result: WindDownDeactivatedOrgsResult,
  failures: WindDownFailureReporter,
): Promise<void> {
  for (const [batchIdx, batch] of chunk(
    dmChannelIds,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    assertRunBudget(failures);
    if (batchIdx > 0) await pause(STREAM_BATCH_PAUSE_MS);
    await Promise.all(
      batch.map(async (channelId) => {
        try {
          await withStreamCircuitBreaker(
            () =>
              chat
                .channel("messaging", channelId)
                .updatePartial({ set: { frozen: true } }),
            undefined,
            failures,
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
    status: string;
    storagePath: string | null;
    previewClipStoragePath: string | null;
  },
  now: Date,
  result: WindDownDeactivatedOrgsResult,
  failures: WindDownFailureReporter,
): Promise<void> {
  assertRunBudget(failures);
  try {
    const [owned] = await prisma.recording.updateManyAndReturn({
      where: {
        id: rec.id,
        organizationId: orgId,
        status: { in: ["READY", "AVAILABLE", "EXPIRED"] },
        storagePath: rec.storagePath,
        previewClipStoragePath: rec.previewClipStoragePath,
        listingStatus: { not: "PUBLISHED" },
        purchases: { none: {} },
      },
      data: {
        status: "EXPIRED",
        recordingUrl: "",
        ...(rec.status === "EXPIRED"
          ? {}
          : { removedAt: now, removalReason: "RETENTION" }),
      },
      select: {
        id: true,
        storagePath: true,
        streamCallId: true,
        streamRecordingId: true,
      },
    });
    if (!owned) {
      result.errors.push(
        `org ${orgId} recording ${rec.id} changed before expiry claim; completion deferred`,
      );
      return;
    }
    const deleted = await purgeExpiredRecordingAssets(owned, failures);
    if (!deleted.success)
      throw new Error(deleted.error ?? "Recording assets remain retryable");
    result.recordingsPurged++;
  } catch (error) {
    result.errors.push(
      `org ${orgId} purge recording ${rec.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function purgeExpiredOrgRecordings(
  org: DeactivatedOrgRow,
  now: Date,
  result: WindDownDeactivatedOrgsResult,
  orgErrorsBefore: number,
  failures: WindDownFailureReporter,
): Promise<void> {
  if (!prisma.recording?.findMany) return;
  const retentionDays =
    org.streamRecordingRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const deactivatedAnchor = resolveDeactivatedAnchor(org);
  const retentionCutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const activeTransfer = await prisma.recording.findFirst({
    where: {
      organizationId: org.id,
      status: "TRANSFERRING",
      purchases: { none: {} },
    },
    select: { id: true },
  });
  if (activeTransfer)
    result.errors.push(
      `org ${org.id} has an active recording transfer; retention completion deferred`,
    );

  const expiredRecordings = await prisma.recording.findMany({
    where: {
      organizationId: org.id,
      OR: [
        { status: { in: ["READY", "AVAILABLE"] } },
        {
          status: "EXPIRED",
          OR: [
            { storagePath: { not: null } },
            { previewClipStoragePath: { not: null } },
            { streamRecordingId: { not: null } },
            { thumbnailUrl: { not: null } },
          ],
        },
      ],
      purchases: { none: {} },
      ...(deactivatedAnchor <= retentionCutoff
        ? {}
        : { createdAt: { lte: retentionCutoff } }),
    },
    select: {
      id: true,
      status: true,
      storagePath: true,
      previewClipStoragePath: true,
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_RECORDINGS_PER_ORG,
  });
  const purgeFull = expiredRecordings.length === MAX_RECORDINGS_PER_ORG;
  if (purgeFull)
    result.errors.push(
      `org ${org.id} recording purge slice full; retention completion deferred`,
    );

  for (const rec of expiredRecordings) {
    await purgeSingleOrgRecording(org.id, rec, now, result, failures);
  }

  if (
    deactivatedAnchor <= retentionCutoff &&
    result.errors.length === orgErrorsBefore &&
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
  failures: WindDownFailureReporter,
): Promise<void> {
  const alreadyWoundDown = (org.auditLogs ?? []).some(
    (log) => log.action === STREAM_ORG_WOUND_DOWN_ACTION,
  );
  const errorsBefore = result.errors.length;

  if (!alreadyWoundDown) {
    await endOrgActiveVideoCalls(org.id, now, result, failures);

    const surfaces = await loadOrgStreamSurfaces(org.id, {
      onlyUnfrozen: true,
    });
    if (surfaces.truncated)
      result.errors.push(
        `org ${org.id} database surface scan truncated; completion deferred`,
      );
    await freezeOrgEventChannels(
      chat,
      org.id,
      surfaces.webinarIds,
      surfaces.classIds,
      now,
      result,
      failures,
    );

    const dmChannelIds = await collectAllOrgDmChannelIds(
      chat,
      org.id,
      surfaces.dmChannelIds,
      result,
      failures,
    );
    await freezeOrgDmChannels(chat, org.id, dmChannelIds, result, failures);

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

  await purgeExpiredOrgRecordings(org, now, result, errorsBefore, failures);
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
  row: { userId: string; organizationId: string; updatedAt: Date },
  result: WindDownDeactivatedOrgsResult,
  failures: WindDownFailureReporter,
): Promise<void> {
  try {
    // Cut at the removal, so a re-run never revokes a token minted after it.
    const outcome = await revokeMemberStreamAccess({
      userId: row.userId,
      orgId: row.organizationId,
      failureReporter: failures,
      revokeTokensIssuedBefore: row.updatedAt,
      deadlineMs: failures.deadlineMs,
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
    failures.add("wind-down-member-removal", err, {
      userId: row.userId,
      organizationId: row.organizationId,
    });
  }
}

async function drainPendingMemberRemovals(
  now: Date,
  result: WindDownDeactivatedOrgsResult,
  failures: WindDownFailureReporter,
  progress: WindDownProgress,
): Promise<void> {
  const windowFrom = new Date(
    now.getTime() - STREAM_REVOCATION_RETRY_WINDOW_HOURS * 3_600_000,
  );
  const readPage = (after: string | null) =>
    prisma.membership.findMany({
      where: {
        status: "REMOVED",
        updatedAt: { gte: windowFrom },
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true, userId: true, organizationId: true, updatedAt: true },
      take: MAX_REMOVED_MEMBERS_PER_RUN,
      orderBy: { id: "asc" },
    });
  let removedRows = await readPage(progress.membership);
  if (!removedRows.length && progress.membership) {
    progress.membership = null;
    removedRows = await readPage(null);
  }
  if (!removedRows.length) {
    progress.membership = null;
    return;
  }
  const rejoinedKeys = await loadRejoinedMemberKeys(removedRows);
  for (const row of removedRows) {
    assertRunBudget(failures);
    if (!rejoinedKeys.has(`${row.userId}:${row.organizationId}`))
      await drainSingleRemovedMember(row, result, failures);
    progress.membership = row.id;
  }
}

if (
  typeof module !== "undefined" &&
  typeof require !== "undefined" &&
  require.main === module
) {
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
