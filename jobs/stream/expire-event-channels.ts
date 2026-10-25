/** Freeze ended event channels and dormant DMs, then request retention deletion. */
import { z } from "zod";

import prisma from "../../lib/prisma";
import type { RunFailureReporter } from "../../lib/observability/run-failures";
import { reportSentryError } from "../../lib/observability/report";
import {
  getStreamChatClient,
  isStreamConfigured,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import {
  getChannelTypeFromId,
  CLASS_PREFIX,
  collabChannelId,
  WEBINAR_PREFIX,
} from "../../lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "../../lib/stream-utils";
import { dmEligibleStatusFilter } from "../../lib/stream/dm-eligibility-statuses";
import { sendSystemMessage } from "../../lib/stream/system-message";
import {
  chunk,
  pause,
  STREAM_BATCH_LIMIT,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "../../lib/stream/batch";
import { readJobCheckpoint, withCronLock } from "../../lib/cron/with-cron-lock";
import {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  FREEZE_AFTER_DAYS,
} from "../../lib/stream/channel-lifecycle";

export { DEFAULT_RETENTION_DAYS, FREEZE_AFTER_DAYS };

const MAX_RETENTION_DAYS = 365;
const LOOKBACK_MARGIN_DAYS = 60;
const MAX_EVENTS_PER_RUN = 25;
const MAX_DM_CHANNELS_PER_RUN = 10;

const PARSED_PACING_MS = Number(process.env.STREAM_FREEZE_PACING_MS);
const FREEZE_PACING_MS =
  Number.isFinite(PARSED_PACING_MS) && PARSED_PACING_MS >= 0
    ? Math.max(PARSED_PACING_MS, STREAM_BATCH_PAUSE_MS)
    : STREAM_BATCH_PAUSE_MS;

const MAX_FREEZE_PER_RUN = 600;
export const DELETE_CHANNELS_PACING_MS = 10_000;
const DM_FREEZE_AFTER_DORMANT_DAYS = 90;
const MAX_DM_PAIRS_PER_RUN = 5_000;
const DEFAULT_CHAT_RETENTION_DAYS = 365;

export interface ExpireEventChannelsResult {
  frozen: number;
  deleted: number;
  skippedAlreadyFrozen: number;
  dmFrozen: number;
  dmUnfrozen: number;
  dmDeleteRequests: number;
  errors: string[];
  success: boolean;
  missingChannels: number;
  checkpoint: string | null;
  deferred: number;
}

interface DmPairRow {
  channelId: string;
  lastActivityAt: Date;
  retentionDays: number;
  chatFrozenAt: Date | null;
  consultationIds: string[];
  subscriptionIds: string[];
  organizationId: string | null;
  inactiveOrganization: boolean;
}

interface EventRow {
  channelId: string;
  endsAt: Date;
  retentionDays: number;
  chatFrozenAt: Date | null;
  entity:
    | { kind: "webinar"; id: string }
    | { kind: "class"; id: string }
    | { kind: "collab"; id: string };
}

function readEndedAppointments(after: string | null, now: Date) {
  const lookbackFrom = new Date(
    now.getTime() - (MAX_RETENTION_DAYS + LOOKBACK_MARGIN_DAYS) * DAY_MS,
  );
  const planCollaboratorsSelect = {
    where: {
      status: "ACCEPTED" as const,
      consultantProfile: { deletedAt: null },
    },
    select: { id: true },
  };
  return prisma.appointment.findMany({
    where: {
      deletedAt: null,
      ...(after ? { id: { gt: after } } : {}),
      OR: [{ webinar: { isNot: null } }, { class: { isNot: null } }],
      occurrences: {
        some: { deletedAt: null, endsAt: { lt: now, gte: lookbackFrom } },
      },
    },
    take: MAX_EVENTS_PER_RUN,
    orderBy: { id: "asc" },
    select: {
      id: true,
      webinar: {
        select: {
          id: true,
          chatFrozenAt: true,
          webinarPlan: {
            select: {
              id: true,
              collaborators: planCollaboratorsSelect,
              organization: {
                select: {
                  chatRetentionDays: true,
                  streamRecordingRetentionDays: true,
                },
              },
            },
          },
        },
      },
      class: {
        select: {
          id: true,
          chatFrozenAt: true,
          classPlan: {
            select: {
              id: true,
              collaborators: planCollaboratorsSelect,
              organization: {
                select: {
                  chatRetentionDays: true,
                  streamRecordingRetentionDays: true,
                },
              },
            },
          },
        },
      },
      organization: {
        select: {
          chatRetentionDays: true,
          streamRecordingRetentionDays: true,
        },
      },
      occurrences: {
        where: { deletedAt: null },
        select: { endsAt: true },
        orderBy: { endsAt: "desc" },
        take: 1,
      },
    },
  });
}
type EndedAppointment = Awaited<
  ReturnType<typeof readEndedAppointments>
>[number];
interface CollaboratorCandidate {
  planType: "webinar" | "class";
  planId: string;
  channelId: string;
  endsAt: Date;
  retentionDays: number;
}
function eventCandidate(appointment: EndedAppointment) {
  const endsAt = appointment.occurrences[0]?.endsAt;
  const booking = appointment.webinar
    ? {
        entity: { kind: "webinar" as const, id: appointment.webinar.id },
        frozenAt: appointment.webinar.chatFrozenAt,
        plan: appointment.webinar.webinarPlan,
        prefix: WEBINAR_PREFIX,
      }
    : appointment.class
      ? {
          entity: { kind: "class" as const, id: appointment.class.id },
          frozenAt: appointment.class.chatFrozenAt,
          plan: appointment.class.classPlan,
          prefix: CLASS_PREFIX,
        }
      : null;
  if (!endsAt || !booking) return null;
  const planOrg = booking.plan?.organization;
  const event: EventRow = {
    channelId: `${booking.prefix}${booking.entity.id}`,
    endsAt,
    retentionDays:
      planOrg?.chatRetentionDays ??
      appointment.organization?.chatRetentionDays ??
      planOrg?.streamRecordingRetentionDays ??
      appointment.organization?.streamRecordingRetentionDays ??
      DEFAULT_RETENTION_DAYS,
    chatFrozenAt: booking.frozenAt,
    entity: booking.entity,
  };
  return { event, plan: booking.plan, planType: booking.entity.kind };
}
function mergeEvent(byChannel: Map<string, EventRow>, event: EventRow): void {
  const existing = byChannel.get(event.channelId);
  if (!existing || existing.endsAt < event.endsAt)
    byChannel.set(event.channelId, event);
  else if (existing.chatFrozenAt === null && event.chatFrozenAt !== null) {
    existing.chatFrozenAt = event.chatFrozenAt;
    existing.entity = event.entity;
  }
}
function mergeCollaborator(
  candidates: Map<string, CollaboratorCandidate>,
  candidate: NonNullable<ReturnType<typeof eventCandidate>>,
): void {
  const { event, plan, planType } = candidate;
  if (!plan?.id || !plan.collaborators.length) return;
  const key = `${planType}:${plan.id}`;
  const previous = candidates.get(key);
  if (!previous)
    candidates.set(key, {
      planType,
      planId: plan.id,
      channelId: collabChannelId(planType, plan.id),
      endsAt: event.endsAt,
      retentionDays: event.retentionDays,
    });
  else if (previous.endsAt < event.endsAt) previous.endsAt = event.endsAt;
}
async function collaboratorEvent(
  candidate: CollaboratorCandidate,
  now: Date,
): Promise<EventRow | null> {
  if (candidate.endsAt >= now) return null;
  const latest = await prisma.appointmentOccurrence.findFirst({
    where: {
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      appointment:
        candidate.planType === "webinar"
          ? { deletedAt: null, webinar: { webinarPlanId: candidate.planId } }
          : { deletedAt: null, class: { classPlanId: candidate.planId } },
    },
    orderBy: { endsAt: "desc" },
    select: { endsAt: true },
  });
  if (!latest || latest.endsAt >= now) return null;
  return {
    channelId: candidate.channelId,
    endsAt: latest.endsAt,
    retentionDays: candidate.retentionDays,
    chatFrozenAt: null,
    entity: { kind: "collab", id: candidate.planId },
  };
}
async function loadEndedEvents(
  after: string | null,
): Promise<{ events: EventRow[]; after: string | null }> {
  const now = new Date();
  const appointments = await readEndedAppointments(after, now);
  if (!appointments.length && after) return loadEndedEvents(null);
  const byChannel = new Map<string, EventRow>();
  const collaborators = new Map<string, CollaboratorCandidate>();
  for (const appointment of appointments) {
    const candidate = eventCandidate(appointment);
    if (!candidate) continue;
    mergeEvent(byChannel, candidate.event);
    mergeCollaborator(collaborators, candidate);
  }
  for (const candidate of collaborators.values()) {
    const event = await collaboratorEvent(candidate, now);
    if (event) byChannel.set(event.channelId, event);
  }
  return {
    events: [...byChannel.values()].filter((event) => event.endsAt < now),
    after: appointments.at(-1)?.id ?? null,
  };
}

/**
 * Every DM-eligible pair, collapsed to one row per CHANNEL.
 *
 * One query per booking kind rather than per pair: this runs daily over the
 * whole history, and a per-pair lookup would be thousands of round trips.
 *
 * A pair can hold several channels at once — the id is a function of the pair
 * AND the funding context, so the same two people have a personal `dm-` channel
 * and a separate `dmo-` one per organization that funded a booking. Grouping by
 * channel id rather than by pair keeps those apart, which matters because an
 * org-funded relationship can end while the personal one continues.
 */
async function loadDmPairs(): Promise<{
  pairs: DmPairRow[];
  /**
   * True when either query filled its page, so the pair set may be INCOMPLETE.
   *
   * This is not a performance note. `lastActivityAt` is a MAX across every
   * booking a pair shares, so a missing booking does not merely omit a pair —
   * it can make a present one look dormant when it is not.
   */
  truncated: boolean;
}> {
  const now = new Date();
  const { retention: orgRetention, inactive } = await loadOrgChatRetention();

  // The scan window has to cover the LONGEST retention any org has actually
  // configured, not the constant. `MAX_RETENTION_DAYS` is 365; an org that sets
  // `chatRetentionDays` to 500 would have every one of its bookings dropped by
  // the bound below and get no deletion at all — silently, and in the direction
  // of keeping data forever rather than deleting it early.
  const configuredMax = Math.max(
    MAX_RETENTION_DAYS,
    DEFAULT_CHAT_RETENTION_DAYS,
    ...orgRetention.values(),
  );
  const lookbackFrom = new Date(
    now.getTime() - (configuredMax + LOOKBACK_MARGIN_DAYS) * DAY_MS,
  );

  const bookingSelect = {
    id: true,
    chatFrozenAt: true,
    requestedBy: { select: { user: { select: { id: true } } } },
  } as const;

  const [consultations, subscriptions] = await Promise.all([
    prisma.consultation.findMany({
      where: { status: dmEligibleStatusFilter() },
      take: MAX_DM_PAIRS_PER_RUN,
      orderBy: { requestedAt: "desc" },
      select: {
        ...bookingSelect,
        consultationPlan: {
          select: {
            organizationId: true,
            consultantProfile: { select: { user: { select: { id: true } } } },
          },
        },
        appointment: {
          select: {
            organizationId: true,
            occurrences: {
              select: { endsAt: true },
              orderBy: { endsAt: "desc" },
              take: 1,
            },
          },
        },
      },
    }),
    prisma.subscription.findMany({
      where: { status: dmEligibleStatusFilter() },
      take: MAX_DM_PAIRS_PER_RUN,
      orderBy: { requestedAt: "desc" },
      select: {
        ...bookingSelect,
        subscriptionPlan: {
          select: {
            organizationId: true,
            consultantProfile: { select: { user: { select: { id: true } } } },
          },
        },
        appointment: {
          select: {
            organizationId: true,
            occurrences: {
              select: { endsAt: true },
              orderBy: { endsAt: "desc" },
              take: 1,
            },
          },
        },
      },
    }),
  ]);

  const byChannel = new Map<string, DmPairRow>();

  const add = (
    kind: "consultation" | "subscription",
    bookingId: string,
    consultantUserId: string | undefined,
    consulteeUserId: string | undefined,
    orgId: string | null,
    lastActivityAt: Date | null,
    chatFrozenAt: Date | null,
  ) => {
    if (
      !consultantUserId ||
      !consulteeUserId ||
      !lastActivityAt ||
      lastActivityAt < lookbackFrom ||
      consultantUserId === consulteeUserId
    )
      return;
    const channelId = getDmChannelId(
      consultantUserId,
      consulteeUserId,
      orgId ?? undefined,
    );

    const existing = byChannel.get(channelId);
    if (!existing) {
      byChannel.set(channelId, {
        channelId,
        lastActivityAt,
        retentionDays: orgId
          ? (orgRetention.get(orgId) ?? DEFAULT_CHAT_RETENTION_DAYS)
          : DEFAULT_CHAT_RETENTION_DAYS,
        chatFrozenAt,
        consultationIds: kind === "consultation" ? [bookingId] : [],
        subscriptionIds: kind === "subscription" ? [bookingId] : [],
        organizationId: orgId,
        inactiveOrganization: orgId !== null && inactive.has(orgId),
      });
      return;
    }

    // The pair is as dormant as their MOST RECENT booking, not their oldest.
    if (existing.lastActivityAt < lastActivityAt) {
      existing.lastActivityAt = lastActivityAt;
    }
    // MAX(chatFrozenAt): any stamp across the pair means the channel is frozen.
    if (
      chatFrozenAt &&
      (!existing.chatFrozenAt || existing.chatFrozenAt < chatFrozenAt)
    ) {
      existing.chatFrozenAt = chatFrozenAt;
    }
    if (kind === "consultation") existing.consultationIds.push(bookingId);
    else existing.subscriptionIds.push(bookingId);
  };

  for (const c of consultations) {
    add(
      "consultation",
      c.id,
      c.consultationPlan?.consultantProfile?.user?.id,
      c.requestedBy?.user?.id,
      bookingOrgId(c),
      c.appointment?.occurrences[0]?.endsAt ?? null,
      c.chatFrozenAt,
    );
  }

  for (const sub of subscriptions) {
    // #1554 — one wrapper; the pair is as active as its latest occurrence.
    const latest: Date | null = sub.appointment?.occurrences[0]?.endsAt ?? null;
    add(
      "subscription",
      sub.id,
      sub.subscriptionPlan?.consultantProfile?.user?.id,
      sub.requestedBy?.user?.id,
      bookingOrgId(sub),
      latest,
      sub.chatFrozenAt,
    );
  }

  return {
    pairs: Array.from(byChannel.values()),
    truncated:
      consultations.length >= MAX_DM_PAIRS_PER_RUN ||
      subscriptions.length >= MAX_DM_PAIRS_PER_RUN,
  };
}

/**
 * Per-org chat retention, read once rather than per booking.
 *
 * Deliberately reads every organization rather than only those with a
 * DM-eligible booking. The scan window below is derived from the LARGEST
 * configured `chatRetentionDays`, and that has to include orgs whose bookings
 * this run has not loaded yet — narrowing the query to the orgs already seen
 * would make the window depend on the page, which is the same
 * incomplete-input-drives-a-destructive-decision shape the truncation guard
 * exists to prevent. Two columns across a table with tens of rows.
 */
async function loadOrgChatRetention() {
  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      chatRetentionDays: true,
      status: true,
      deletedAt: true,
    },
  });
  return {
    retention: new Map(orgs.map((o) => [o.id, o.chatRetentionDays])),
    inactive: new Set(
      orgs
        .filter(
          (o) =>
            o.status === "DEACTIVATED" ||
            (o.deletedAt !== null && o.deletedAt !== undefined),
        )
        .map((o) => o.id),
    ),
  };
}

/**
 * Sort every pair into freeze / unfreeze / delete.
 *
 * Pure, and extracted from `runDmStage` so it can be tested directly and so
 * neither function carries the whole decision — the combined version tripped
 * SonarCloud's cognitive-complexity gate at 20 against a limit of 15.
 */
function classifyDmPairs(
  pairs: DmPairRow[],
  now: number,
): {
  toFreeze: DmPairRow[];
  toUnfreeze: DmPairRow[];
  toDelete: DmPairRow[];
  alreadyFrozen: number;
} {
  const toFreeze: DmPairRow[] = [];
  const toUnfreeze: DmPairRow[] = [];
  const toDelete: DmPairRow[] = [];
  let alreadyFrozen = 0;

  for (const pair of pairs) {
    const dormantFor = now - pair.lastActivityAt.getTime();

    if (dormantFor >= pair.retentionDays * DAY_MS) {
      // Past retention wins, as in the event stage: no point freezing something
      // being deleted.
      toDelete.push(pair);
    } else if (dormantFor >= DM_FREEZE_AFTER_DORMANT_DAYS * DAY_MS) {
      // Each redundant updatePartial spends one of the app-wide 300/min budget,
      // which is how the 2026-08-23 burst happened.
      if (pair.chatFrozenAt) alreadyFrozen++;
      else toFreeze.push(pair);
    } else if (pair.chatFrozenAt && !pair.inactiveOrganization) {
      // Active again, and the ledger says we froze them. This is the branch the
      // whole design turns on.
      toUnfreeze.push(pair);
    }
  }

  return { toFreeze, toUnfreeze, toDelete, alreadyFrozen };
}

/**
 * The DM stage: freeze a dormant pair's channel, UNFREEZE one that came back,
 * and delete past retention.
 *
 * The unfreeze is not optional and is the reason this cannot simply reuse the
 * event stage. An event never resumes, so a frozen event channel stays frozen
 * correctly. A pair does resume — they book again — and without a reversal the
 * first thing a returning consultee would find is a channel they cannot post
 * in, with Stream granting `use-frozen-channel` to no role and therefore no
 * error text explaining why. Freezing without unfreezing would be a worse bug
 * than never freezing at all.
 *
 * Shares the run's pacing budget with the event stage rather than running as a
 * second cron. UpdateChannelPartial is capped at 300/min APP-WIDE, so two jobs
 * each pacing to half of it independently could still collide; one job that
 * paces across both stages cannot.
 *
 * @param freezeBudget how many freeze-class calls the event stage left unspent.
 */
interface DeletePacingState {
  lastCallAt: number | null;
}

async function paceDeleteChannelsBatch(
  pacing: DeletePacingState,
): Promise<void> {
  if (pacing.lastCallAt !== null) {
    const elapsed = Date.now() - pacing.lastCallAt;
    if (elapsed < DELETE_CHANNELS_PACING_MS) {
      await pause(DELETE_CHANNELS_PACING_MS - elapsed);
    }
  }
  pacing.lastCallAt = Date.now();
}

async function runDmStage(
  chat: ReturnType<typeof getStreamChatClient>,
  result: ExpireEventChannelsResult,
  freezeBudget: number,
  deletePacing: DeletePacingState,
  streamFailures: RunFailureReporter,
  progress: { events: string | null; dm: string | null },
): Promise<void> {
  const { pairs: allPairs, truncated } = await loadDmPairs();
  const ordered = [...allPairs];
  ordered.sort((a, b) =>
    a.channelId < b.channelId ? -1 : Number(a.channelId > b.channelId),
  );
  const after = progress.dm;
  const tail = after ? ordered.filter((p) => p.channelId > after) : ordered;
  const pairs = (tail.length ? tail : ordered).slice(
    0,
    MAX_DM_CHANNELS_PER_RUN,
  );
  result.deferred += allPairs.length - pairs.length;
  if (pairs.length === 0) return;

  const { toFreeze, toUnfreeze, toDelete, alreadyFrozen } = classifyDmPairs(
    pairs,
    Date.now(),
  );
  result.skippedAlreadyFrozen += alreadyFrozen;
  progress.dm = pairs.at(-1)?.channelId ?? null;

  // Unfreeze FIRST, and outside the budget. A frozen channel belonging to an
  // active pair is a live user-facing fault; a dormant pair staying unfrozen
  // one more day is not. Spending the run's remaining calls on freezes while a
  // returning consultee cannot message their consultant would be the wrong way
  // round.
  await applyDmFrozen(chat, toUnfreeze, false, result, streamFailures);

  const freezeBatch = toFreeze.slice(0, Math.max(freezeBudget, 0));
  await applyDmFrozen(chat, freezeBatch, true, result, streamFailures);
  if (toFreeze.length > freezeBatch.length) {
    result.deferred += toFreeze.length - freezeBatch.length;
  }

  // Delete — but NEVER from a page that may be incomplete.
  //
  // Both booking queries cap at MAX_DM_PAIRS_PER_RUN and order by
  // `requestedAt`, which is not the key dormancy is measured on. A long-running
  // booking is requested once and then generates sessions for years, so it
  // sorts old and is the first thing a full page drops. If a pair keeps one
  // low-activity booking on the page and loses its active one, `lastActivityAt`
  // is computed from the stale row, the pair classifies as past retention, and
  // `hard_delete: true` destroys the chat history of a live consulting
  // relationship. That is not recoverable.
  //
  // Freezing on a truncated page IS recoverable — the next run sees the pair as
  // active and unfreezes it — so only the delete stage is withheld. The run is
  // marked unsuccessful so the cron reports it rather than passing green while
  // silently skipping work.
  if (truncated) {
    result.success = false;
    result.errors.push(
      `dm scan truncated at ${MAX_DM_PAIRS_PER_RUN} bookings — delete stage skipped ` +
        `(${toDelete.length} candidates held back; an incomplete page can make an active pair look dormant)`,
    );
    return;
  }

  // Same batching as the event stage; `deleteChannels` caps at 100 cids.
  for (const batch of chunk(toDelete, STREAM_BATCH_LIMIT)) {
    await paceDeleteChannelsBatch(deletePacing);
    const cids = batch.map(
      (pair) => `${getChannelTypeFromId(pair.channelId)}:${pair.channelId}`,
    );
    try {
      await withStreamCircuitBreaker(
        () => chat.deleteChannels(cids, { hard_delete: true }),
        undefined,
        streamFailures,
      );
      // Counts channels SENT for deletion, not channels that existed to delete.
      // `deleteChannels` is idempotent and returns a task id rather than a
      // per-cid outcome, so a pair that crossed retention is re-sent on every
      // run until it ages past the scan window — bounded by `lookbackFrom`
      // (largest configured retention + 60 days), not unbounded, but real. The
      // name says requests because that is what the number is.
      result.dmDeleteRequests += cids.length;
    } catch (error) {
      result.success = false;
      result.errors.push(
        `dm delete batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      streamFailures.add("dm-delete-batch", error);
    }
  }
}

/**
 * Set `frozen` on a set of DM channels and move the pair ledger to match.
 *
 * The ledger write happens only after Stream confirms, and only for the pairs
 * it confirmed. Stamping ahead of the call could leave a channel unfrozen
 * forever while the ledger claimed otherwise; a missed stamp only costs one
 * redundant call on the next run.
 *
 * Every booking the pair shares is written, not just one. The read side takes
 * MAX(chatFrozenAt) across the pair, so a partial write would let a second
 * booking report the channel as unfrozen when it is not.
 */
async function applyDmFrozen(
  chat: ReturnType<typeof getStreamChatClient>,
  pairs: DmPairRow[],
  frozen: boolean,
  result: ExpireEventChannelsResult,
  streamFailures: RunFailureReporter,
): Promise<void> {
  if (pairs.length === 0) return;
  const verb = frozen ? "freeze" : "unfreeze";

  for (const [batchIdx, batch] of chunk(
    pairs,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) await pause(FREEZE_PACING_MS);

    await announceFreeze(batch, frozen);

    const outcomes = await Promise.allSettled(
      batch.map((pair) =>
        withStreamCircuitBreaker(
          () =>
            chat
              .channel(getChannelTypeFromId(pair.channelId), pair.channelId)
              .updatePartial({ set: { frozen } }),
          undefined,
          streamFailures,
        ),
      ),
    );

    const consultationIds: string[] = [];
    const subscriptionIds: string[] = [];
    const orgIds = frozen
      ? []
      : batch.flatMap((pair) =>
          pair.organizationId ? [pair.organizationId] : [],
        );
    const inactiveAfter = new Set(
      orgIds.length
        ? (
            await prisma.organization.findMany({
              where: {
                id: { in: orgIds },
                OR: [{ status: "DEACTIVATED" }, { deletedAt: { not: null } }],
              },
              select: { id: true },
            })
          ).map((org) => org.id)
        : [],
    );
    const refreeze: DmPairRow[] = [];
    outcomes.forEach((outcome, i) => {
      const pair = batch[i];
      if (outcome.status === "fulfilled") {
        if (
          !frozen &&
          pair.organizationId &&
          inactiveAfter.has(pair.organizationId)
        ) {
          refreeze.push(pair);
          return;
        }
        if (frozen) result.dmFrozen++;
        else result.dmUnfrozen++;
        consultationIds.push(...pair.consultationIds);
        subscriptionIds.push(...pair.subscriptionIds);
      } else if (isExpectedStreamError(outcome.reason)) {
        result.missingChannels++;
      } else {
        result.success = false;
        streamFailures.add("dm-freeze", outcome.reason);
        result.errors.push(
          `dm ${verb} ${pair.channelId}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });

    await writeDmLedger(consultationIds, subscriptionIds, frozen, verb, result);
    // A concurrent wind-down must win over an unfreeze based on an earlier booking snapshot.
    if (refreeze.length)
      await applyDmFrozen(chat, refreeze, true, result, streamFailures);
  }
}

/**
 * Tell the pair why the channel is about to stop accepting messages.
 *
 * Before the freeze, not after: Stream grants `use-frozen-channel` to no role,
 * so a frozen channel refuses every send with no error text the user ever sees
 * — including this one, if it were sent second.
 *
 * Only on the way in. Unfreezing needs no announcement; the channel simply
 * works again, and a "you may post now" notice in a conversation nobody has
 * touched for three months is noise.
 */
async function announceFreeze(
  batch: DmPairRow[],
  frozen: boolean,
): Promise<void> {
  if (!frozen) return;
  await Promise.allSettled(
    batch.map((pair) =>
      sendSystemMessage(
        pair.channelId,
        `This conversation has been archived after ${DM_FREEZE_AFTER_DORMANT_DAYS} days without a session. ` +
          "The history stays available, and booking again reopens it.",
        { event: "chat_frozen_dormant" },
      ),
    ),
  );
}

/**
 * Move the pair ledger to match what Stream confirmed.
 *
 * Every booking the pair shares, not just one: the read side takes
 * MAX(chatFrozenAt) across the pair, so a partial write would let a second
 * booking report the channel as unfrozen when it is not.
 */
async function writeDmLedger(
  consultationIds: string[],
  subscriptionIds: string[],
  frozen: boolean,
  verb: string,
  result: ExpireEventChannelsResult,
): Promise<void> {
  const stamp = frozen ? new Date() : null;
  try {
    await Promise.all([
      consultationIds.length > 0 &&
        prisma.consultation.updateMany({
          where: { id: { in: consultationIds } },
          data: { chatFrozenAt: stamp },
        }),
      subscriptionIds.length > 0 &&
        prisma.subscription.updateMany({
          where: { id: { in: subscriptionIds } },
          data: { chatFrozenAt: stamp },
        }),
    ]);
  } catch (err) {
    result.success = false;
    result.errors.push(
      `dm ${verb} ledger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Per-batch Stream failures collapse to one event per op per run.
function channelExpiryFailures(): RunFailureReporter {
  let count = 0;
  let first: unknown;
  const seen = new Set<unknown>();
  const sample: Array<Record<string, unknown>> = [];
  return {
    add(operation, error, context = {}) {
      if (seen.has(error)) return;
      seen.add(error);
      if (count++ === 0 || context.reason === "stream.billing") first = error;
      if (sample.length < 10) sample.push({ operation, ...context });
    },
    flush() {
      if (count === 0) return;
      reportSentryError(first, {
        subsystem: "stream",
        op: "expire-event-channels",
        level: "error",
        fingerprint: ["stream", "expire-event-channels"],
        extra: { count, sample },
      });
    },
  };
}

export async function expireEventChannels(): Promise<ExpireEventChannelsResult> {
  // Flush inside the lock: a call refused by the lock never flushes the
  // running sweep's failures.
  return withCronLock(
    "expire-event-channels",
    { failMode: "closed" },
    async () => {
      const streamFailures = channelExpiryFailures();
      try {
        return await expireEventChannelsUnlocked(streamFailures);
      } finally {
        streamFailures.flush();
      }
    },
  );
}

function classifyEvents(
  events: EventRow[],
  now: number,
  result: ExpireEventChannelsResult,
) {
  const toFreeze: EventRow[] = [];
  const toDelete: string[] = [];

  for (const event of events) {
    const age = now - event.endsAt.getTime();
    if (age >= event.retentionDays * DAY_MS) {
      // Past retention wins: no point freezing something we are deleting.
      toDelete.push(event.channelId);
    } else if (age >= FREEZE_AFTER_DAYS * DAY_MS) {
      if (event.chatFrozenAt) {
        // Ledger hit — the channel is already frozen on Stream. Re-issuing the
        // updatePartial would succeed as a no-op but still spend one
        // UpdateChannelPartial call, which is exactly how the 2026-08-23 burst
        // happened. Skip without touching the API.
        result.skippedAlreadyFrozen++;
      } else {
        toFreeze.push(event);
      }
    }
  }

  return { toFreeze, toDelete };
}
async function freezeEvents(
  chat: ReturnType<typeof getStreamChatClient>,
  toFreeze: EventRow[],
  result: ExpireEventChannelsResult,
  streamFailures: RunFailureReporter,
) {
  const freezeBatch = toFreeze.slice(0, MAX_FREEZE_PER_RUN);
  for (const [batchIdx, batch] of chunk(
    freezeBatch,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) {
      await pause(FREEZE_PACING_MS);
    }
    const outcomes = await Promise.allSettled(
      batch.map((event) =>
        withStreamCircuitBreaker(
          () =>
            chat
              .channel(getChannelTypeFromId(event.channelId), event.channelId)
              .updatePartial({ set: { frozen: true } }),
          undefined,
          streamFailures,
        ),
      ),
    );
    const stamped: { webinarIds: string[]; classIds: string[] } = {
      webinarIds: [],
      classIds: [],
    };
    outcomes.forEach((outcome, i) => {
      const event = batch[i];
      if (outcome.status === "fulfilled") {
        result.frozen++;
        if (event.entity.kind === "webinar") {
          stamped.webinarIds.push(event.entity.id);
        } else if (event.entity.kind === "class") {
          stamped.classIds.push(event.entity.id);
        }
      } else if (isExpectedStreamError(outcome.reason)) {
        result.missingChannels++;
      } else {
        result.success = false;
        streamFailures.add("event-freeze", outcome.reason);
        result.errors.push(
          `freeze ${event.channelId}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });
    // Stamp the ledger only after the Stream call succeeded, best-effort per
    // model. A missed stamp costs one redundant freeze next run — safe by
    // construction; a premature stamp could leave a channel unfrozen forever,
    // which is not.
    try {
      await Promise.all([
        stamped.webinarIds.length > 0 &&
          prisma.webinar.updateMany({
            where: { id: { in: stamped.webinarIds } },
            data: { chatFrozenAt: new Date() },
          }),
        stamped.classIds.length > 0 &&
          prisma.class.updateMany({
            where: { id: { in: stamped.classIds } },
            data: { chatFrozenAt: new Date() },
          }),
      ]);
    } catch (err) {
      result.success = false;
      result.errors.push(
        `ledger stamp: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (toFreeze.length > freezeBatch.length) {
    result.deferred += toFreeze.length - freezeBatch.length;
  }
}
async function deleteEvents(
  chat: ReturnType<typeof getStreamChatClient>,
  toDelete: string[],
  result: ExpireEventChannelsResult,
  deletePacing: DeletePacingState,
  streamFailures: RunFailureReporter,
) {
  for (const batch of chunk(toDelete, STREAM_BATCH_LIMIT)) {
    await paceDeleteChannelsBatch(deletePacing);
    const cids = batch.map(
      (channelId) => `${getChannelTypeFromId(channelId)}:${channelId}`,
    );
    try {
      await withStreamCircuitBreaker(
        () => chat.deleteChannels(cids, { hard_delete: true }),
        undefined,
        streamFailures,
      );
      result.deleted += cids.length;
    } catch (error) {
      result.success = false;
      result.errors.push(
        `delete batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      streamFailures.add("event-delete-batch", error);
    }
  }
}

async function expireEventChannelsUnlocked(
  streamFailures: RunFailureReporter,
): Promise<ExpireEventChannelsResult> {
  const result: ExpireEventChannelsResult = {
    frozen: 0,
    deleted: 0,
    skippedAlreadyFrozen: 0,
    dmFrozen: 0,
    dmUnfrozen: 0,
    dmDeleteRequests: 0,
    missingChannels: 0,
    checkpoint: null,
    deferred: 0,
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
  const saved = await readJobCheckpoint("expire-event-channels");
  const progressSchema = z.object({
    events: z.string().nullable(),
    dm: z.string().nullable(),
  });
  const progress = saved
    ? progressSchema.parse(JSON.parse(saved))
    : { events: null, dm: null };
  const page = await loadEndedEvents(progress.events);
  const events = page.events;

  const { toFreeze, toDelete } = classifyEvents(events, now, result);
  const chat = getStreamChatClient();
  await freezeEvents(chat, toFreeze, result, streamFailures);
  const deletePacing: DeletePacingState = { lastCallAt: null };
  await deleteEvents(chat, toDelete, result, deletePacing, streamFailures);

  // #1280 PR F — direct messages, keyed on pair dormancy.
  //
  // Runs after the event stage and takes what is left of the same per-run
  // freeze cap. UpdateChannelPartial is capped at 300/min APP-WIDE, so the two
  // stages must not each spend a full budget: a heavy event night should slow
  // the DM sweep, not breach the cap alongside it. Whatever is deferred is
  // picked up tomorrow — the ledger makes resume cheap.
  //
  // Wrapped, because a DM failure must not lose the event stage's result. This
  // function is the only writer of `frozen`/`deleted`, and the caller reports
  // them.
  try {
    await runDmStage(
      chat,
      result,
      MAX_FREEZE_PER_RUN - result.frozen,
      deletePacing,
      streamFailures,
      progress,
    );
  } catch (error) {
    result.success = false;
    result.errors.push(
      `dm stage: ${error instanceof Error ? error.message : String(error)}`,
    );
    streamFailures.add("dm-stage", error);
  }

  progress.events = page.after;
  result.checkpoint = JSON.stringify(progress);
  console.log(
    JSON.stringify({
      event: "expire_event_channels",
      frozen: result.frozen,
      skippedAlreadyFrozen: result.skippedAlreadyFrozen,
      deleted: result.deleted,
      dmFrozen: result.dmFrozen,
      dmUnfrozen: result.dmUnfrozen,
      dmDeleteRequests: result.dmDeleteRequests,
      errorCount: result.errors.length,
      errorSamples: result.errors
        .slice(0, 5)
        .map((message) => message.slice(0, 1000)),
      missingChannels: result.missingChannels,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}
