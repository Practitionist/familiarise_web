/**
 * Post-event chat channel lifecycle (#1134 P1-17).
 *
 * Nothing ever ended a webinar or class chat. `getWebinarIdsForUser` and
 * `getClassIdsForUser` have no date or status filter, so the reconcile pass
 * could never mark a finished event stale and attendees stayed members forever.
 * Channel count and membership grew without bound on a product billed per MAU,
 * and there was no retention answer for a compliance review.
 *
 * Two stages, decided in #1134:
 *   +7 days after the session ends  → FREEZE. History stays readable, nobody can
 *      post. Long enough for the real follow-up Q&A, which for a class or cohort
 *      is often where the value lands; short enough to bound membership.
 *   +retention days                 → DELETE, hard. Reuses the org's existing
 *      `streamRecordingRetentionDays` dial (default 90) rather than inventing a
 *      second number to explain.
 *
 * Both stages are idempotent: freezing a frozen channel and deleting a deleted
 * one are no-ops, so a partial run simply resumes.
 */
import "dotenv/config";

import * as Sentry from "@sentry/nextjs";

import prisma from "../../lib/prisma";
import {
  getStreamChatClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import { getChannelTypeFromId, CLASS_PREFIX, WEBINAR_PREFIX } from "../../lib/stream-channel-ids";
import {
  chunk,
  STREAM_BATCH_LIMIT,
  STREAM_CONCURRENCY_LIMIT,
} from "../../lib/stream/batch";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

/** Grace period between a session ending and its chat going read-only. */
export const FREEZE_AFTER_DAYS = 7;

/** Fallback when an appointment has no org (B2C), matching the schema default. */
export const DEFAULT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back to look for events still needing a stage applied.
 *
 * Without a lower bound this scanned EVERY ended webinar and class in history on
 * every daily run, and re-issued `deleteChannels` for channels deleted months
 * ago. Both stages are idempotent so nothing broke, but the work grew
 * monotonically with the product and every run paid for it in Stream API calls.
 *
 * An event is fully handled once `endsAt + retentionDays` has passed, so
 * anything older than the longest retention we honour has nothing left to do.
 * The margin is what makes that safe: the job can be down for a month, or an org
 * can carry a longer dial than the default, and the window still covers it.
 * `MAX_RETENTION_DAYS` is deliberately generous rather than derived — being
 * wrong in this direction costs one wasted query, being wrong the other way
 * leaves a channel undeleted forever.
 */
const MAX_RETENTION_DAYS = 365;
const LOOKBACK_MARGIN_DAYS = 60;

/** Backstop so one pathological run cannot hold the cron open indefinitely. */
const MAX_EVENTS_PER_RUN = 5_000;

export interface ExpireEventChannelsResult {
  frozen: number;
  deleted: number;
  errors: string[];
  success: boolean;
}

interface EventRow {
  channelId: string;
  endsAt: Date;
  retentionDays: number;
}

/**
 * Every webinar/class whose last slot has ended, with the retention window that
 * applies to it. One query rather than per-appointment lookups: this runs daily
 * over the whole history, so N+1 here would be thousands of round-trips.
 */
async function loadEndedEvents(): Promise<EventRow[]> {
  const now = new Date();
  const lookbackFrom = new Date(
    now.getTime() - (MAX_RETENTION_DAYS + LOOKBACK_MARGIN_DAYS) * DAY_MS,
  );
  const appointments = await prisma.appointment.findMany({
    where: {
      OR: [{ webinar: { isNot: null } }, { class: { isNot: null } }],
      slotsOfAppointment: {
        some: { endsAt: { lt: now, gte: lookbackFrom } },
      },
    },
    take: MAX_EVENTS_PER_RUN,
    orderBy: { createdAt: "desc" },
    select: {
      webinar: { select: { id: true } },
      class: { select: { id: true } },
      organization: { select: { streamRecordingRetentionDays: true } },
      slotsOfAppointment: {
        select: { endsAt: true },
        orderBy: { endsAt: "desc" },
        take: 1,
      },
    },
  });

  // A webinar spans many appointments (one per attendee cohort) but ONE channel,
  // so collapse to the latest end across all of them. Freezing on the earliest
  // would cut off a channel whose later sessions are still running.
  const byChannel = new Map<string, EventRow>();
  for (const appointment of appointments) {
    const endsAt = appointment.slotsOfAppointment[0]?.endsAt;
    if (!endsAt) continue;

    const channelId = appointment.webinar
      ? `${WEBINAR_PREFIX}${appointment.webinar.id}`
      : appointment.class
        ? `${CLASS_PREFIX}${appointment.class.id}`
        : null;
    if (!channelId) continue;

    const retentionDays =
      appointment.organization?.streamRecordingRetentionDays ??
      DEFAULT_RETENTION_DAYS;

    const existing = byChannel.get(channelId);
    if (!existing || existing.endsAt < endsAt) {
      byChannel.set(channelId, { channelId, endsAt, retentionDays });
    }
  }
  return Array.from(byChannel.values());
}

export async function expireEventChannels(): Promise<ExpireEventChannelsResult> {
  return withCronLock("expire-event-channels", { failMode: "open" }, () =>
    expireEventChannelsUnlocked(),
  );
}

async function expireEventChannelsUnlocked(): Promise<ExpireEventChannelsResult> {
  const result: ExpireEventChannelsResult = {
    frozen: 0,
    deleted: 0,
    errors: [],
    success: true,
  };

  if (!isStreamConfigured()) {
    // Not a no-op success. The cron reports `success` and exits 0 on it, so a
    // Stream config that silently went missing — the exact failure #1134 found
    // in production, where the webhook secret was simply unset on Netlify —
    // would show up as a green nightly run for as long as it lasted.
    result.errors.push("Stream is not configured — nothing to do");
    result.success = false;
    return result;
  }

  const now = Date.now();
  const events = await loadEndedEvents();
  if (events.length === 0) return result;

  const toFreeze: string[] = [];
  const toDelete: string[] = [];

  for (const event of events) {
    const age = now - event.endsAt.getTime();
    if (age >= event.retentionDays * DAY_MS) {
      // Past retention wins: no point freezing something we are deleting.
      toDelete.push(event.channelId);
    } else if (age >= FREEZE_AFTER_DAYS * DAY_MS) {
      toFreeze.push(event.channelId);
    }
  }

  const chat = getStreamChatClient();

  // Freeze. Per-channel rather than bulk because Stream has no batch freeze, so
  // the chunk size here is a CONCURRENCY width and not a payload ceiling —
  // chunking by STREAM_BATCH_LIMIT fired a hundred simultaneous requests at an
  // app that also serves live user traffic. allSettled so one missing channel
  // cannot abort the run.
  for (const batch of chunk(toFreeze, STREAM_CONCURRENCY_LIMIT)) {
    const outcomes = await Promise.allSettled(
      batch.map((channelId) =>
        withStreamCircuitBreaker(() =>
          chat
            .channel(getChannelTypeFromId(channelId), channelId)
            .updatePartial({ set: { frozen: true } }),
        ),
      ),
    );
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        result.frozen++;
      } else {
        // A channel that was never created is the common case (chat is lazy),
        // not a failure worth failing the run over.
        result.errors.push(
          `freeze ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });
  }

  // Delete. `deleteChannels` takes cids and caps at 100 per request; it is
  // async server-side (it returns a task id), which is fine — we are not
  // waiting on the outcome, and a re-run of an already-deleted channel is a
  // no-op.
  for (const batch of chunk(toDelete, STREAM_BATCH_LIMIT)) {
    const cids = batch.map(
      (channelId) => `${getChannelTypeFromId(channelId)}:${channelId}`,
    );
    try {
      await withStreamCircuitBreaker(() =>
        chat.deleteChannels(cids, { hard_delete: true }),
      );
      result.deleted += cids.length;
    } catch (error) {
      result.success = false;
      result.errors.push(
        `delete batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" } },
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "expire_event_channels",
      frozen: result.frozen,
      deleted: result.deleted,
      errorCount: result.errors.length,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}

if (require.main === module) {
  runJob("expire-event-channels", async () => {
    await abortIfMaintenance("expire-event-channels");
    try {
      const result = await expireEventChannels();
      console.log(
        `Frozen: ${result.frozen}  Deleted: ${result.deleted}  Errors: ${result.errors.length}`,
      );
      if (!result.success) process.exitCode = 1;
    } finally {
      // In a `finally` so a throw cannot leak the pool. `runJob` reports the
      // error and lets it propagate, which skipped this line entirely.
      await prisma.$disconnect();
    }
  });
}
