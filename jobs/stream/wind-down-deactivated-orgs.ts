/**
 * Organisation wind-down — the Stream half of a closed organisation.
 *
 * ## The gap this closes
 *
 * `DELETE /api/organizations/[orgId]` soft-deletes by flipping the org to
 * `DEACTIVATED` and scrubbing contact PII. Nothing in that path touched Stream.
 * So after an org was closed:
 *
 *   - every `webinar-*` / `class-*` channel stayed OPEN and WRITABLE, and every
 *     `dmo-<org>-…` thread stayed readable, for anyone still holding a valid
 *     token — including people the org had already removed (see
 *     `lib/enterprise/member-removal.ts`);
 *   - every live call stayed joinable by anyone who had the call id, because
 *     Stream's permission system is bypassed by its own server API and
 *     `resolveMeetingAccess` is the only app-side gate;
 *   - recordings stayed listed on Explore and their bytes stayed in our bucket,
 *     against an organisation record that no longer exists.
 *
 * The hard-delete branch had a second, sharper problem: `Meeting.organizationId`
 * and `Recording.organizationId` are both `onDelete: SetNull`, so deleting the
 * `Organization` row LEFT the `Meeting` rows pointing at live Stream call ids
 * with no tenant tag at all — orphaned, unattributable calls and recordings that
 * nothing could ever find again. The route now stamps
 * `Meeting.endedReason = "org_deleted"` inside the same transaction, which is
 * what Stage 1 below drains.
 *
 * ## Why a job and not the request
 *
 * A soft-deleted org can have thousands of members, channels, calls and
 * recordings. Ending and freezing those is a vendor workload measured in
 * minutes; the DELETE request must not hold a Lambda for it. The soft-delete
 * branch therefore records the intent locally (it already does — `DEACTIVATED`
 * IS the record) and this job drains it within a day.
 *
 * ## Idempotency
 *
 * Every stage is safe to re-run, which is what makes the daily schedule and the
 * `withCronLock` wrapper enough rather than a claim table:
 *
 *   - `call.end()` on an ended call is a no-op on Stream's side.
 *   - `updatePartial({ frozen: true })` is value-idempotent; the event half is
 *     LEDGERED on `Webinar.chatFrozenAt` / `Class.chatFrozenAt` so an
 *     already-frozen channel costs no API call, exactly as
 *     `jobs/stream/expire-event-channels.ts` does.
 *   - `revokeUserToken(id, now)` moves a timestamp that is already in the past.
 *   - recording quarantine is a `where: { status: { not: "EXPIRED" } }` filter,
 *     so a quarantined row drops out of the selector by construction.
 *   - Stage 1 clears its own `endedReason` marker once Stream confirms.
 *
 * ## What is deliberately NOT here
 *
 * Hard-deleting the channels. A closed org's history is a compliance record
 * and its retention dial is the org's own `chatRetentionDays` /
 * `streamRecordingRetentionDays`; freezing stops the writing, and
 * `expire-event-channels` owns the deletion at that dial. This job refuses to be
 * the thing that destroys history on a schedule nobody chose.
 */
import "dotenv/config";

import prisma from "../../lib/prisma";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isStreamConfigured,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import {
  CLASS_PREFIX,
  WEBINAR_PREFIX,
  getChannelTypeFromId,
} from "../../lib/stream-channel-ids";
import { STREAM_CALL_TYPE, toCallId } from "../../lib/stream/call-cid";
import {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
} from "../../lib/stream/channel-lifecycle";
import {
  chunk,
  pause,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "../../lib/stream/batch";
import { RecordingService } from "../../lib/stream/recording-service";
import { deleteRecordingObject } from "../../lib/stream/recording-storage";
import { deleteRecordingPreviewAssets } from "../../lib/supabase";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import { reportSentryError } from "../../lib/observability/report";

/** Job name — the cron lock key, the maintenance label and the audit tag. */
export const JOB_NAME = "wind-down-deactivated-orgs";

/**
 * `Meeting.endedReason` marker written by `DELETE /api/organizations/[orgId]`
 * inside the hard-delete transaction.
 *
 * NOT the same column the `call.ended` webhook writes, deliberately used for a
 * different fact: this one means "the owning organisation is gone and this call
 * still needs tearing down", which is true at the moment it is written. The
 * webhook overwrites `endedReason` with `call_ended` the moment Stream confirms
 * the end, so the ledger self-clears on the happy path; the explicit clear in
 * Stage 1 is only needed for a call that never existed on Stream.
 */
export const ORG_DELETED_TEARDOWN_MARKER = "org_deleted";

/** Orgs examined per run. Oldest first, so a backlog drains in age order. */
const MAX_ORGS_PER_RUN = 25;
/** Calls ended per org per run. A backlog resumes tomorrow. */
const MAX_CALLS_PER_ORG = 100;
/** Channels frozen per org per run — the UpdateChannelPartial 300/min budget. */
const MAX_CHANNELS_PER_ORG = 200;
/** Recordings quarantined per org per run. */
const MAX_RECORDINGS_PER_ORG = 100;
/** Pending member-revocation debts re-driven per run. */
const MAX_MEMBER_RETRIES_PER_RUN = 100;
/** Stranded hard-delete teardowns re-driven per run. */
const MAX_STRANDED_CALLS_PER_RUN = 100;

export interface WindDownOptions {
  maxOrgs?: number;
  /** Test seam: overrides the clock for the retry window. */
  now?: Date;
}

export interface WindDownResult {
  orgsScanned: number;
  /** Calls Stream confirmed it ended. */
  callsEnded: number;
  channelsFrozen: number;
  channelsSkippedAlreadyFrozen: number;
  /** Token revocations issued for the org's (former) members. */
  tokensRevoked: number;
  /** Recordings unpublished from the marketplace / had public previews stripped. */
  recordingsQuarantined: number;
  /** Recordings whose stored bytes were purged (past the org's retention dial). */
  recordingsPurged: number;
  /** Removed memberships whose Stream revocation was re-driven. */
  memberRevocationsDriven: number;
  /** Hard-deleted orgs' calls re-driven via the `org_deleted` marker. */
  strandedCallTeardowns: number;
  /**
   * A surface scan hit its row cap. Every page we did load was still acted on;
   * what we could not see is next run's work. Set so the workflow can report a
   * backlog rather than passing green.
   */
  truncated: boolean;
  errors: string[];
  success: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

// #476 — every scheduled entry shares one mutual exclusion. Fail-OPEN: this
// job's side effects are all idempotent, so an unreachable Redis costs a
// duplicated run, never a double refund or a double deletion.
export async function windDownDeactivatedOrgs(
  opts: WindDownOptions = {},
): Promise<WindDownResult> {
  return withCronLock(JOB_NAME, { failMode: "open" }, () =>
    windDownUnlocked(opts),
  );
}

async function windDownUnlocked(
  opts: WindDownOptions,
): Promise<WindDownResult> {
  const result: WindDownResult = {
    orgsScanned: 0,
    callsEnded: 0,
    channelsFrozen: 0,
    channelsSkippedAlreadyFrozen: 0,
    tokensRevoked: 0,
    recordingsQuarantined: 0,
    recordingsPurged: 0,
    memberRevocationsDriven: 0,
    strandedCallTeardowns: 0,
    truncated: false,
    errors: [],
    success: true,
  };

  if (!isStreamConfigured()) {
    // Not a no-op success — the same reasoning `expire-event-channels` gives.
    // A silently-lost Stream config would otherwise show as a green nightly run
    // for as long as it lasted.
    result.errors.push("Stream is not configured — nothing to do");
    result.success = false;
    return result;
  }

  // Stage 1 BEFORE the orgs: a hard-deleted org has no row to find, so its
  // calls are only reachable through the marker the route stamped.
  await drainStrandedHardDeletes(result);

  await windDownClosedOrgs(result, opts);
  await drainPendingMemberRevocations(result, opts);

  // A stage that left work unlanded did not succeed; `jobs/` reads this to
  // decide the workflow's exit code.
  result.success = result.errors.length === 0 && !result.truncated;

  console.log(
    JSON.stringify({
      event: "wind_down_deactivated_orgs",
      orgsScanned: result.orgsScanned,
      callsEnded: result.callsEnded,
      channelsFrozen: result.channelsFrozen,
      tokensRevoked: result.tokensRevoked,
      recordingsQuarantined: result.recordingsQuarantined,
      recordingsPurged: result.recordingsPurged,
      memberRevocationsDriven: result.memberRevocationsDriven,
      strandedCallTeardowns: result.strandedCallTeardowns,
      truncated: result.truncated,
      errorCount: result.errors.length,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — calls stranded by a HARD-deleted org                             */
/* -------------------------------------------------------------------------- */

interface StrandedCall {
  id: string;
  streamCallId: string;
}

/**
 * `Meeting.organizationId` is `onDelete: SetNull`, so a hard-deleted org's
 * meetings survive with no tenant tag — unfindable by org, and still pointing at
 * live Stream calls. The DELETE route stamps `ORG_DELETED_TEARDOWN_MARKER` on
 * them inside the same transaction that removes the org, which is what makes
 * them findable again.
 *
 * A call Stream does not know about answers 404, which `isExpectedStreamError`
 * recognises as "Stream is up and said no such thing". That is the success case:
 * the call is not running, which is all this stage needed.
 */
async function drainStrandedHardDeletes(result: WindDownResult): Promise<void> {
  const stranded = (await prisma.meeting.findMany({
    where: { endedReason: ORG_DELETED_TEARDOWN_MARKER, endedAt: null },
    take: MAX_STRANDED_CALLS_PER_RUN,
    orderBy: { createdAt: "asc" },
    select: { id: true, streamCallId: true },
  })) as StrandedCall[];

  for (const meeting of stranded) {
    const ended = await endStreamCall(meeting.streamCallId, result, meeting.id);
    if (!ended) continue;
    // Clear the marker so the row leaves the selector. Scoped to the marker
    // value so a `call.ended` webhook that already replaced it is not undone.
    await prisma.meeting
      .updateMany({
        where: { id: meeting.id, endedReason: ORG_DELETED_TEARDOWN_MARKER },
        data: { endedReason: null },
      })
      .catch((err) =>
        result.errors.push(
          `clear teardown marker ${meeting.id}: ${errMsg(err)}`,
        ),
      );
    result.strandedCallTeardowns++;
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — DEACTIVATED organisations                                         */
/* -------------------------------------------------------------------------- */

async function windDownClosedOrgs(
  result: WindDownResult,
  opts: WindDownOptions,
): Promise<void> {
  const maxOrgs = opts.maxOrgs ?? MAX_ORGS_PER_RUN;
  const orgs = await prisma.organization.findMany({
    where: { status: "DEACTIVATED" },
    take: maxOrgs,
    // Oldest first: a backlog drains in the order the orgs were closed.
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      name: true,
      chatRetentionDays: true,
      streamRecordingRetentionDays: true,
    },
  });
  result.orgsScanned = orgs.length;
  if (orgs.length >= maxOrgs) result.truncated = true;

  for (const org of orgs) {
    try {
      await endOrgCalls(org.id, result);
      await freezeOrgChannels(org.id, result);
      await revokeOrgTokens(org.id, result);
      await quarantineOrgRecordings(org, result);
    } catch (err) {
      // Per-org isolation: one org's malformed surface must not cost every
      // later org its run. Same rule as `drainActiveSessions`, where an
      // unguarded rejection skipped the entire maintenance posture.
      result.success = false;
      result.errors.push(`org ${org.id}: ${errMsg(err)}`);
      reportSentryError(err, {
        subsystem: "stream",
        op: `${JOB_NAME}.org`,
        extra: { orgId: org.id },
      });
    }
  }
}

/**
 * End every call the org still owns.
 *
 * `Meeting.endedAt` is deliberately NOT written here. The `call.ended` webhook
 * owns that column — writing it first would make the handler treat the event as
 * a duplicate and skip the duration, slot completion and earnings work that
 * ride on it. `app/api/meetings/[meetingId]/end/route.ts` states the same rule
 * for the same reason.
 */
async function endOrgCalls(
  orgId: string,
  result: WindDownResult,
): Promise<void> {
  const rows = await prisma.meeting.findMany({
    where: { organizationId: orgId, endedAt: null },
    take: MAX_CALLS_PER_ORG,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      streamCallId: true,
      isRecording: true,
      endedReason: true,
    },
  });
  if (rows.length >= MAX_CALLS_PER_ORG) result.truncated = true;

  // Filtered in JS, not in the query: `endedReason` is nullable and
  // `endedReason: { not: MARKER }` would exclude every NULL row too (SQL
  // three-valued logic), which is almost every meeting. These are Stage 1's
  // to re-drive, and Stage 1 ran first — anything still marked is one it could
  // not end.
  const calls = rows.filter(
    (m) => m.endedReason !== ORG_DELETED_TEARDOWN_MARKER,
  );

  for (const call of calls) {
    // An in-flight recording is billed by participant-minute and its
    // processing must be allowed to finish, so stop it before ending the call
    // — the maintenance drain's ordering, for the same reason.
    if (call.isRecording) {
      try {
        await RecordingService.stopRecording(call.streamCallId);
        await prisma.meeting.update({
          where: { id: call.id },
          data: { isRecording: false },
        });
      } catch (err) {
        result.errors.push(
          `stop recording ${call.streamCallId}: ${errMsg(err)}`,
        );
      }
    }
    if (await endStreamCall(call.streamCallId, result, call.id)) {
      result.callsEnded++;
    }
  }
}

/**
 * Freeze every chat surface the org owns.
 *
 * Frozen, not deleted: history stays readable (a closed org's chat is a
 * compliance record) and every send is refused, which is the whole requirement.
 * `expire-event-channels` owns deletion at the org's retention dial.
 *
 * Event channels are ledgered — `Webinar.chatFrozenAt` / `Class.chatFrozenAt` —
 * so an already-frozen channel costs zero API calls. That ledger exists
 * precisely because the un-ledgered version re-issued `updatePartial` for every
 * channel in the age band nightly until ~300 of them tripped Stream's per-minute
 * cap. DM channels have no such column (the ledger is per BOOKING row and a DM
 * is per PAIR), so they are simply re-frozen; the call is value-idempotent.
 */
async function freezeOrgChannels(
  orgId: string,
  result: WindDownResult,
): Promise<void> {
  // Lazy: keeps this job's module graph off the request path's copy of the
  // Stream primitives, and is the same indirection `scrub-user.ts` uses.
  const { loadOrgStreamSurfaces } =
    await import("../../lib/enterprise/member-removal");
  const surfaces = await loadOrgStreamSurfaces(orgId);
  const eventIds = surfaces.eventChannelIds.slice(0, MAX_CHANNELS_PER_ORG);
  const dmIds = surfaces.dmChannelIds.slice(
    0,
    Math.max(MAX_CHANNELS_PER_ORG - eventIds.length, 0),
  );
  if (
    surfaces.eventChannelIds.length > eventIds.length ||
    surfaces.dmChannelIds.length > dmIds.length
  ) {
    result.truncated = true;
  }

  const unstamped = await unledgeredEventChannels(eventIds);
  result.channelsSkippedAlreadyFrozen += eventIds.length - unstamped.length;

  const chat = getStreamChatClient();
  const toFreeze = [...unstamped, ...dmIds];

  for (const [batchIdx, batch] of chunk(
    toFreeze,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    // UpdateChannelPartial is capped at 300/min APP-WIDE and shared with the
    // daily expire cron; concurrency alone is not rate control.
    if (batchIdx > 0) await pause(STREAM_BATCH_PAUSE_MS);
    const outcomes = await Promise.allSettled(
      batch.map((channelId) =>
        withStreamCircuitBreaker(() =>
          chat
            .channel(getChannelTypeFromId(channelId), channelId)
            .updatePartial({ set: { frozen: true } }),
        ),
      ),
    );
    const frozen: string[] = [];
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        frozen.push(batch[i]);
      } else if (isExpectedStreamError(outcome.reason)) {
        // A channel that was never minted is the common case — chat is lazy.
        // Counting it as frozen would let the ledger claim a freeze that never
        // happened; counting it as a failure would page on every closed org.
      } else {
        result.errors.push(`freeze ${batch[i]}: ${errMsg(outcome.reason)}`);
      }
    });
    result.channelsFrozen += frozen.length;
    // Ledger AFTER the call confirmed, successes only — the rule
    // `expire-event-channels` follows. A missed stamp costs one redundant
    // freeze next run; a premature one leaves a channel writable forever.
    await stampFreezeLedger(frozen, result);
  }
}

/**
 * Drop event channels the ledger already says are frozen.
 *
 * The id carries its entity (`webinar-<id>` / `class-<id>`), so the ledger is
 * read by parsing the id — the same two prefixes `lib/stream-channel-ids.ts`
 * owns, not a fresh `startsWith` guess.
 */
async function unledgeredEventChannels(
  channelIds: string[],
): Promise<string[]> {
  const webinarIds = channelIds
    .filter((id) => id.startsWith(WEBINAR_PREFIX))
    .map((id) => id.slice(WEBINAR_PREFIX.length));
  const classIds = channelIds
    .filter((id) => id.startsWith(CLASS_PREFIX))
    .map((id) => id.slice(CLASS_PREFIX.length));

  const [webinars, classes] = await Promise.all([
    webinarIds.length > 0
      ? prisma.webinar.findMany({
          where: { id: { in: webinarIds } },
          select: { id: true, chatFrozenAt: true },
        })
      : [],
    classIds.length > 0
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, chatFrozenAt: true },
        })
      : [],
  ]);
  const frozenWebinars = new Set(
    webinars.filter((w) => w.chatFrozenAt).map((w) => w.id),
  );
  const frozenClasses = new Set(
    classes.filter((c) => c.chatFrozenAt).map((c) => c.id),
  );

  return channelIds.filter((id) => {
    if (id.startsWith(WEBINAR_PREFIX)) {
      return !frozenWebinars.has(id.slice(WEBINAR_PREFIX.length));
    }
    if (id.startsWith(CLASS_PREFIX)) {
      return !frozenClasses.has(id.slice(CLASS_PREFIX.length));
    }
    return true;
  });
}

async function stampFreezeLedger(
  frozenChannelIds: string[],
  result: WindDownResult,
): Promise<void> {
  const webinarIds = frozenChannelIds
    .filter((id) => id.startsWith(WEBINAR_PREFIX))
    .map((id) => id.slice(WEBINAR_PREFIX.length));
  const classIds = frozenChannelIds
    .filter((id) => id.startsWith(CLASS_PREFIX))
    .map((id) => id.slice(CLASS_PREFIX.length));
  if (webinarIds.length === 0 && classIds.length === 0) return;
  try {
    await Promise.all([
      webinarIds.length > 0 &&
        prisma.webinar.updateMany({
          where: { id: { in: webinarIds } },
          data: { chatFrozenAt: new Date() },
        }),
      classIds.length > 0 &&
        prisma.class.updateMany({
          where: { id: { in: classIds } },
          data: { chatFrozenAt: new Date() },
        }),
    ]);
  } catch (err) {
    result.errors.push(`freeze ledger: ${errMsg(err)}`);
  }
}

/**
 * Revoke every token the org's former members hold.
 *
 * `revokeUserToken` is app-wide, and that is correct here for the same reason
 * it is safe in the ban path: tokens carry `iat`, so anyone still an active
 * member somewhere re-mints a token dated after this instant and keeps the
 * access they are entitled to. What this buys is that no live socket from a
 * closed org's room, and no token minted before the close, survives it.
 */
async function revokeOrgTokens(
  orgId: string,
  result: WindDownResult,
): Promise<void> {
  const memberships = await prisma.membership.findMany({
    where: { organizationId: orgId },
    select: { userId: true },
  });
  const userIds = Array.from(new Set(memberships.map((m) => m.userId)));
  const chat = getStreamChatClient();
  for (const userId of userIds) {
    try {
      await withStreamCircuitBreaker(() =>
        chat.revokeUserToken(userId, new Date()),
      );
      result.tokensRevoked++;
    } catch (err) {
      // A person who never connected to Stream 404s. That IS the desired
      // state, so it is not an error worth failing the run over.
      if (isExpectedStreamError(err)) continue;
      result.errors.push(`revoke token ${userId}: ${errMsg(err)}`);
    }
  }
}

/**
 * Quarantine the org's recordings.
 *
 * Two tiers, deliberately:
 *
 *   QUARANTINE (every recording) — unpublish from the Explore marketplace and
 *   delete the PUBLIC preview assets. A closed org must not have its replays
 *   sellable, and the preview bucket is world-readable, so leaving it is a
 *   disclosure, not merely untidiness.
 *
 *   PURGE (only past the org's own `streamRecordingRetentionDays`) — delete the
 *   private Supabase object and tombstone the row, byte-for-byte what
 *   `scripts/cleanup/cleanup-old-stream-recordings.ts` does. Bytes are governed by
 *   the org's retention dial, not by the wind-down: an operator who closed an org
 *   is closing its membership, and the retention clock they set still applies.
 *
 * The Stream S3 copy is not deleted, for the reason the retention cron gives at
 * length: Stream's lifecycle is configured per-channel, not per-recording, so a
 * per-recording delete is not ours to make.
 */
async function quarantineOrgRecordings(
  org: { id: string; streamRecordingRetentionDays: number },
  result: WindDownResult,
): Promise<void> {
  const retentionDays =
    org.streamRecordingRetentionDays || DEFAULT_RETENTION_DAYS;
  const recordings = await prisma.recording.findMany({
    where: { organizationId: org.id, status: { not: "EXPIRED" } },
    take: MAX_RECORDINGS_PER_ORG,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      storagePath: true,
      recordedAt: true,
    },
  });
  if (recordings.length >= MAX_RECORDINGS_PER_ORG) result.truncated = true;

  const toPurge = recordings.filter(
    (r) => Date.now() - r.recordedAt.getTime() >= retentionDays * DAY_MS,
  );
  const purgeIds: string[] = [];

  for (const recording of toPurge) {
    if (!recording.storagePath) {
      purgeIds.push(recording.id);
      continue;
    }
    // Bytes BEFORE the tombstone, exactly as the retention cron does: an
    // EXPIRED row whose object was never deleted is orphaned storage and a
    // retention violation, and the `not: EXPIRED` selector would never revisit
    // it.
    const deleted = await deleteRecordingObject(recording.storagePath);
    if (deleted.success) purgeIds.push(recording.id);
    else {
      result.errors.push(
        `recording ${recording.id}: ${deleted.error ?? "object delete failed"}`,
      );
    }
  }

  try {
    await prisma.recording.updateMany({
      where: { id: { in: purgeIds } },
      data: {
        status: "EXPIRED",
        storageUrl: null,
        storagePath: null,
        storageType: "STREAM_S3",
      },
    });
    await prisma.recording.updateMany({
      where: {
        id: { in: recordings.map((r) => r.id) },
        listingStatus: { not: "UNPUBLISHED" },
      },
      data: { listingStatus: "UNPUBLISHED", publishedAt: null },
    });
  } catch (err) {
    result.errors.push(`recording quarantine ${org.id}: ${errMsg(err)}`);
    return;
  }
  result.recordingsPurged += purgeIds.length;
  result.recordingsQuarantined += recordings.length;

  // Public previews are a separate bucket and a separate disclosure surface, so
  // they go for EVERY quarantined row, not only the ones that were listed — a
  // row unpublished earlier still has its preview folder, and that bucket is
  // world-readable. Best-effort by contract: the helper swallows and reports.
  await Promise.all(recordings.map((r) => deleteRecordingPreviewAssets(r.id)));
}

/* -------------------------------------------------------------------------- */
/* Stage 3 — the member-removal revocation queue                              */
/* -------------------------------------------------------------------------- */

/**
 * Re-drive the Stream revocation a member removal owed and did not land.
 *
 * ## Why this reads `Membership` and not a dedicated outbox table
 *
 * `StreamRevocationRetry` (#1593) is the typed outbox — but it is
 * ERASURE-scoped in a way that cannot express this debt: `erasureRequestId` is
 * `NOT NULL` with an `onDelete: Cascade` FK, and the sweep reads the subject
 * through it (`erasureRequest.userId`) and re-drives `revokeCollaboratorAccess`,
 * a webinar/class PLAN concept. An org membership removal has no plan and no
 * erasure request, and inventing one to satisfy the FK would put a DPDP erasure
 * record on the books for what is a tenancy decision.
 *
 * So this is the OTHER outbox shape the repo already ships and already
 * documents, from `Appointment.chatChannelEnsuredAt` (#1356):
 *
 *   "Stamped only once the Stream calls have actually succeeded, which makes
 *    `NULL` on a confirmed appointment the exact work queue the reconcile sweep
 *    re-drives — no separate outbox table, because the appointment row already
 *    is the durable record of the work."
 *
 * The `Membership` row is the same shape: `transitionMembership` writes REMOVED
 * inside the removal transaction, so the debt is durable and atomic with the
 * local fact by construction, and `revokeMemberStreamAccess` re-derives
 * everything else. `revokeMemberStreamAccess` also carries its own
 * still-applicable guard, so a reactivation inside the window is never undone.
 *
 * The window (`STREAM_REVOCATION_RETRY_WINDOW_HOURS`) replaces the typed row's
 * `attempts` + `nextRetryAt`: bounded, oldest-first, capped per run, and past it
 * the debt is a bug for a human rather than a seventh attempt — the same
 * `giveUpAfterHours` horizon `retry-moderation-enforcement` uses. A run that
 * leaves a debt unlanded reports `success: false` so the workflow pages.
 *
 * This selector is deliberately NOT narrowed to rows this module wrote. Every
 * route that moves a `Membership` to `REMOVED` — the self-leave flow, the admin
 * bulk tools — has exactly the same hole, and this queue closes all of them.
 */
async function drainPendingMemberRevocations(
  result: WindDownResult,
  opts: WindDownOptions,
): Promise<void> {
  const now = opts.now ?? new Date();
  const { STREAM_REVOCATION_RETRY_WINDOW_HOURS, revokeMemberStreamAccess } =
    await import("../../lib/enterprise/member-removal");
  const since = new Date(
    now.getTime() - STREAM_REVOCATION_RETRY_WINDOW_HOURS * 3_600_000,
  );

  const pending = await prisma.membership.findMany({
    where: { status: "REMOVED", updatedAt: { gte: since } },
    take: MAX_MEMBER_RETRIES_PER_RUN,
    orderBy: { updatedAt: "asc" },
    select: { id: true, userId: true, organizationId: true },
  });
  if (pending.length >= MAX_MEMBER_RETRIES_PER_RUN) result.truncated = true;

  for (const membership of pending) {
    try {
      const outcome = await revokeMemberStreamAccess({
        userId: membership.userId,
        orgId: membership.organizationId,
      });
      if (outcome.skipped === "stream_unconfigured") {
        result.errors.push(`membership ${membership.id}: ${outcome.error}`);
        continue;
      }
      if (outcome.error) {
        result.errors.push(`membership ${membership.id}: ${outcome.error}`);
        continue;
      }
      result.memberRevocationsDriven++;
    } catch (err) {
      result.errors.push(`membership ${membership.id}: ${errMsg(err)}`);
      reportSentryError(err, {
        subsystem: "stream",
        op: `${JOB_NAME}.member-revocation`,
        extra: {
          membershipId: membership.id,
          orgId: membership.organizationId,
        },
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * End one call on Stream. Returns whether the call is confirmed not running.
 *
 * A 404 is a success: "Stream is up and told us this call does not exist" is the
 * state this stage exists to reach, and it is the normal answer for a room that
 * was opened and closed before anyone joined. An outage never looks like this,
 * so nothing real is swallowed.
 */
async function endStreamCall(
  streamCallId: string,
  result: WindDownResult,
  meetingId: string,
): Promise<boolean> {
  try {
    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, toCallId(streamCallId))
        .end(),
    );
    return true;
  } catch (err) {
    if (isExpectedStreamError(err)) return true;
    result.errors.push(
      `end call ${streamCallId} (meeting ${meetingId}): ${errMsg(err)}`,
    );
    return false;
  }
}

if (require.main === module) {
  runJob(JOB_NAME, async () => {
    await abortIfMaintenance(JOB_NAME);
    try {
      const result = await windDownDeactivatedOrgs();
      console.log(
        `Orgs scanned      : ${result.orgsScanned}\n` +
          `Calls ended       : ${result.callsEnded}` +
          ` (+${result.strandedCallTeardowns} stranded hard-deletes)\n` +
          `Channels frozen   : ${result.channelsFrozen}` +
          `  (${result.channelsSkippedAlreadyFrozen} already frozen)\n` +
          `Tokens revoked    : ${result.tokensRevoked}\n` +
          `Member revocations: ${result.memberRevocationsDriven}\n` +
          `Recordings        : ${result.recordingsQuarantined} quarantined,` +
          ` ${result.recordingsPurged} purged\n` +
          `Errors            : ${result.errors.length}`,
      );
      if (!result.success) process.exitCode = 1;
    } finally {
      // In a `finally` so a throw cannot leak the pool. `runJob` reports the
      // error and lets it propagate, which would skip this line entirely.
      await prisma.$disconnect();
    }
  });
}
