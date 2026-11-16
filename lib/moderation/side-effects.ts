/**
 * Moderation action side-effects (#693) — two-phase execution.
 *
 * Phase 1 (applyTransactionalEffects) runs inside the action route's
 * interactive transaction: user ban flags, session revocation, earnings hold,
 * profile unverification, review soft-delete. All-or-nothing with the
 * ModerationAction row, so a report can never read ACTION_TAKEN while the
 * target's account state didn't move.
 *
 * Phase 2 (applyBestEffortEffects) runs after commit: the revoked sessions'
 * access-log stamps, bulk cancel + refunds
 * (refundPayment owns its own Serializable tx), Stream revocation, Novu.
 * Each step is individually try/caught — one failure never blocks the next —
 * and the outcome lands in ModerationAction.sideEffects for staff visibility.
 */
import * as Sentry from "@sentry/nextjs";
import type {
  ModerationActionType,
  ModerationReportType,
} from "@prisma/client";
import { EarningStatus, EarningsHoldReason } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { endCollaborationsForUser } from "@/lib/collaborators/ending";
import type { PlanRef } from "@/lib/collaborators/team";
import { recomputeConsultantRating } from "@/lib/reviews";
import {
  getStreamChatClient,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import {
  HOLDABLE_EARNING_STATUSES,
  placeEarningsHolds,
} from "@/lib/payments/payouts/earnings-holds";
import {
  notifyModerationWarning,
  notifyAccountSuspended,
  notifyAccountBanned,
  notifyVerificationStatusChanged,
  type StagedTrigger,
} from "@/lib/novu";
import { revokeAllUserSessions } from "@/lib/auth/session-revoke";
import {
  stampSessionEnds,
  type EndedSessions,
} from "@/lib/auth/session-access-log";
import {
  prepareVerificationDecidedEmail,
  stageVerificationDecidedEmail,
  type VerificationDecidedEmailArgs,
} from "@/lib/email/senders/onboarding";
import {
  prepareAccountModerationEmail,
  prepareModerationReportOutcomeEmail,
  stageAccountModerationEmail,
  stageModerationReportOutcomeEmail,
  type AccountModerationEmailArgs,
  type ModerationReportOutcomeEmailArgs,
} from "@/lib/email/senders/people";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import {
  cancelFutureEngagementsForUser,
  type BulkCancelSummary,
} from "./cancel-user-engagements";
import { formatReportReference } from "./report-reference";
import { reportReasonLabel } from "@/lib/labels/report-reasons";
import { stageBell } from "@/lib/novu/stage-bell";
import type { StagedEmailBundleEntry } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";

export interface ModerationReportRef {
  id: string;
  type: ModerationReportType;
  reason?: string;
  reportedById?: string;
  targetUserId: string;
  reviewId: string | null;
  feedbackId?: string | null;
  streamMessageId?: string | null;
  streamChannelCid?: string | null;
}

export interface ModerationSideEffectInput {
  actionId?: string;
  actionType: ModerationActionType;
  report: ModerationReportRef;
  staffUserId: string;
  notes?: string;
  /** Required for USER_SUSPENDED. */
  suspensionDays?: number;
}

export interface TransactionalEffectResult {
  sessionsRevoked?: number;
  earningsHeld?: number;
  profilesUnverified?: number;
  reviewRemoved?: boolean;
  reviewExcludedFromAggregate?: boolean;
  /** The reviewed expert, notified in-transaction when their review is excluded. */
  expertUserId?: string;
  /** Whose public surfaces need purging once the transaction commits. */
  reviewRemovedConsultantProfileId?: string;
  banExpires?: string | null;
  collaborationsRemoved?: PlanRef[];
  stagedBells?: StagedTrigger[];
  stagedEmails?: StagedEmailBundleEntry[];
  /** Revoked sessions for the access log; phase 2 stamps them, never persisted. */
  stagedSessionEnds?: EndedSessions[];
}

export type StepStatus = "ok" | "failed" | "skipped" | "gave_up";

export interface SideEffectSummary extends TransactionalEffectResult {
  cancellations?: BulkCancelSummary;
  stream?: StepStatus;
  streamAttempts?: number;
  notification?: StepStatus;
  collaboratorRevocation?: StepStatus;
  collaboratorRevocationAttempts?: number;
  errors?: string[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const captureModerationError = (error: unknown) =>
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "moderation" } },
  );

/** Structured statement of reasons stating policy ground, human review, and appeal path. */
export function moderationStatementOfReasons(params: {
  actionType: ModerationActionType;
  reportId: string;
  reportReason?: string;
}): string {
  const reference = formatReportReference(params.reportId);
  const ground = reportReasonLabel(params.reportReason ?? "OTHER");
  const base =
    params.actionType === "NO_ACTION"
      ? `No policy violation requiring enforcement was identified under ground "${ground}".`
      : `Action applied under policy ground "${ground}".`;
  return `${base} A human moderator reviewed this report; no automated decision was used. If you disagree with this decision, open a request from Support and quote ${reference}.`;
}

/** Reporter-facing words for how a report was decided. */
export function reportOutcomeCopy(
  actionType: ModerationActionType,
  reportId = "00000000",
  reportReason?: string,
): {
  outcome: string;
  reason: string;
} {
  return {
    outcome:
      actionType === "NO_ACTION"
        ? "decided: no action needed"
        : "decided: action taken",
    reason: moderationStatementOfReasons({
      actionType,
      reportId,
      reportReason,
    }),
  };
}

/** True when the reporter already hears about this action as the reviewed expert. */
export function reporterIsNotifiedExpert(
  input: ModerationSideEffectInput,
  result: TransactionalEffectResult,
): boolean {
  return (
    input.actionType === "REVIEW_EXCLUDED_FROM_AGGREGATE" &&
    !!result.expertUserId &&
    input.report.reportedById === result.expertUserId
  );
}

async function stageReporterDispositionBell(
  tx: Tx,
  input: ModerationSideEffectInput,
): Promise<StagedTrigger | null> {
  if (!input.report.reportedById) return null;
  const reference = formatReportReference(input.report.id);
  const dedupeSuffix = input.actionId ?? input.actionType;
  return stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.MODERATION_REPORT_OUTCOME,
    recipients: [input.report.reportedById],
    payload: {
      reportId: input.report.id,
      reference,
      ...reportOutcomeCopy(
        input.actionType,
        input.report.id,
        input.report.reason,
      ),
      dashboardUrl: goHref("auto", "support/reports"),
    },
    dedupeKey: `report-disposition:${input.report.id}:${dedupeSuffix}`,
  });
}

function statementReasonFor(input: ModerationSideEffectInput): string {
  return moderationStatementOfReasons({
    actionType: input.actionType,
    reportId: input.report.id,
    reportReason: input.report.reason,
  });
}

function targetNoticeArgs(
  input: ModerationSideEffectInput,
): AccountModerationEmailArgs | null {
  const removed =
    input.actionType === "CONTENT_REMOVED" ||
    input.actionType === "REVIEW_REMOVED";
  if (!removed && input.actionType !== "WARNING_ISSUED") return null;
  return {
    userId: input.report.targetUserId,
    kind: removed ? "CONTENT_REMOVED" : "MODERATION_WARNING",
    reason: statementReasonFor(input),
    supportUrl: "/support",
  };
}

function verificationNoticeArgs(
  input: ModerationSideEffectInput,
): VerificationDecidedEmailArgs | null {
  if (input.actionType !== "PROFILE_UNVERIFIED") return null;
  return {
    userId: input.report.targetUserId,
    verificationId: `moderation:${input.report.id}`,
    status: "REJECTED",
    reason: statementReasonFor(input),
    dashboardUrl: goHref("expert", "settings"),
  };
}

function reporterNoticeArgs(
  input: ModerationSideEffectInput,
): ModerationReportOutcomeEmailArgs | null {
  if (!input.report.reportedById) return null;
  return {
    reporterUserId: input.report.reportedById,
    reportId: input.report.id,
    reference: formatReportReference(input.report.id),
    ...reportOutcomeCopy(
      input.actionType,
      input.report.id,
      input.report.reason,
    ),
    dashboardUrl: goHref("auto", "support/reports"),
  };
}

/** Notices rendered before the moderation transaction; each stages only if its inputs still match. */
export interface ModerationNoticeDrafts {
  target?: PreparedSpecEmails | null;
  verification?: PreparedSpecEmails | null;
  reporter?: PreparedSpecEmails | null;
}

async function draft<TArgs>(
  args: TArgs | null,
  prepare: (args: TArgs) => Promise<PreparedSpecEmails>,
): Promise<PreparedSpecEmails | null> {
  return args ? prepare(args).catch(() => null) : null;
}

/** Renders the decision's email notices outside the transaction that applies it. */
export async function prepareModerationNotices(
  input: ModerationSideEffectInput,
): Promise<ModerationNoticeDrafts> {
  return {
    target: await draft(targetNoticeArgs(input), prepareAccountModerationEmail),
    verification: await draft(
      verificationNoticeArgs(input),
      prepareVerificationDecidedEmail,
    ),
    reporter: await draft(
      reporterNoticeArgs(input),
      prepareModerationReportOutcomeEmail,
    ),
  };
}

export async function applyTransactionalEffects(
  tx: Tx,
  input: ModerationSideEffectInput,
  drafts: ModerationNoticeDrafts = {},
): Promise<TransactionalEffectResult> {
  const result = await applyActionEffects(tx, input);
  const stagedBells: StagedTrigger[] = [...(result.stagedBells ?? [])];
  const stagedEmails: StagedEmailBundleEntry[] = [
    ...(result.stagedEmails ?? []),
  ];
  const statementReason = statementReasonFor(input);
  const targetArgs = targetNoticeArgs(input);
  const verificationArgs = verificationNoticeArgs(input);

  if (
    input.actionType === "CONTENT_REMOVED" ||
    input.actionType === "REVIEW_REMOVED"
  ) {
    const contentRemovedSuffix = input.actionId ?? input.report.id;
    const contentRemovedBell = await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.CONTENT_REMOVED_NOTICE,
      recipients: [input.report.targetUserId],
      payload: {
        reason: statementReason,
        supportUrl: "/support",
      },
      dedupeKey: `content-removed:${contentRemovedSuffix}`,
    });
    if (contentRemovedBell) stagedBells.push(contentRemovedBell);
  }
  if (targetArgs) {
    const targetRows = await stageAccountModerationEmail(
      tx,
      targetArgs,
      drafts.target,
    );
    stagedEmails.push({
      rows: targetRows,
      emailType:
        targetArgs.kind === "CONTENT_REMOVED"
          ? "CONTENT_REMOVED_NOTICE"
          : "MODERATION_WARNING",
    });
  }
  if (verificationArgs) {
    const unverifiedEmail = await stageVerificationDecidedEmail(
      tx,
      verificationArgs,
      drafts.verification,
    );
    stagedEmails.push({
      rows: unverifiedEmail.list,
      emailType: "VERIFICATION_DECIDED",
    });
  }

  // The expert already gets the exclusion notice; one message is enough.
  if (!reporterIsNotifiedExpert(input, result)) {
    const outcomeBell = await stageReporterDispositionBell(tx, input);
    if (outcomeBell) stagedBells.push(outcomeBell);
    const reporterArgs = reporterNoticeArgs(input);
    if (reporterArgs) {
      const outcomeRows = await stageModerationReportOutcomeEmail(
        tx,
        reporterArgs,
        drafts.reporter,
      );
      stagedEmails.push({
        rows: outcomeRows,
        emailType: "MODERATION_REPORT_OUTCOME",
      });
    }
  }

  return {
    ...result,
    stagedBells,
    stagedEmails,
  };
}

async function applyActionEffects(
  tx: Tx,
  input: ModerationSideEffectInput,
): Promise<TransactionalEffectResult> {
  const { actionType, report } = input;
  switch (actionType) {
    case "USER_SUSPENDED":
    case "USER_BANNED":
      return banOrSuspendUser(tx, input);
    case "PROFILE_UNVERIFIED":
      return unverifyProfiles(tx, report.targetUserId, input.staffUserId);
    case "CONTENT_REMOVED":
      if (report.type !== "REVIEW") return {};
      return softDeleteReview(tx, report.reviewId);
    case "REVIEW_EXCLUDED_FROM_AGGREGATE":
      return excludeReviewFromAggregate(tx, report);
    case "FEEDBACK_EXCLUDED_FROM_AGGREGATE":
      return excludeFeedbackFromAggregate(tx, report.feedbackId);
    case "WARNING_ISSUED":
    case "NO_ACTION":
    case "USER_REINSTATED":
    case "REVIEW_REMOVED":
    case "REVIEW_REPLY_REMOVED":
    case "REVIEW_RESTORED":
    case "REVIEW_REPLY_RESTORED":
    case "RATING_REINSTATED":
      // A restoration undoes an earlier removal, so it carries no enforcement
      // effect of its own; the reversal itself runs in the appeal path.
      return {};
  }
}

async function banOrSuspendUser(
  tx: Tx,
  input: ModerationSideEffectInput,
): Promise<TransactionalEffectResult> {
  const { actionType, report, notes, suspensionDays, staffUserId } = input;
  const banExpires =
    actionType === "USER_SUSPENDED"
      ? new Date(Date.now() + (suspensionDays ?? 7) * 86_400_000)
      : null;
  await tx.user.update({
    where: { id: report.targetUserId },
    data: {
      banned: true,
      banReason: notes ?? `moderation: ${actionType}`,
      banExpires,
    },
  });
  const result: TransactionalEffectResult = {
    banExpires: banExpires ? banExpires.toISOString() : null,
  };

  // #1856 — the shared choke point, joined to this transaction so a
  // rolled-back ban leaves no orphaned revoke (and vice versa). Direct
  // Prisma is correct here: BetterAuth's admin `revokeUserSessions`
  // endpoint is caller-scoped (needs the calling admin's session) and
  // cannot join this tx.
  const revoked = await revokeAllUserSessions(tx, report.targetUserId);
  result.sessionsRevoked = revoked.revoked;
  result.stagedSessionEnds = revoked.ended;

  if (actionType === "USER_BANNED") {
    const earningsHeld = await holdBannedConsultantEarnings(
      tx,
      report.targetUserId,
    );
    if (earningsHeld !== undefined) result.earningsHeld = earningsHeld;
  }

  // A ban is permanent, so it ends every collaboration. A suspension has an
  // end date: the account cannot sign in meanwhile and keeps its place.
  if (actionType === "USER_BANNED") {
    const teams = await endCollaborationsAsModeration(
      tx,
      report.targetUserId,
      staffUserId,
    );
    if (teams.length > 0) result.collaborationsRemoved = teams;
  }
  return result;
}

// Freezes the banned consultant's unpaid earnings under a MODERATION hold for
// admin disposition; rows another owner already holds gain this hold too.
// Undefined when the target has no consultant profile.
async function holdBannedConsultantEarnings(
  tx: Tx,
  targetUserId: string,
): Promise<number | undefined> {
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { consultantProfileId: true },
  });
  if (!target?.consultantProfileId) return undefined;

  const holdable = await tx.consultantEarnings.findMany({
    where: {
      consultantProfileId: target.consultantProfileId,
      status: { in: [...HOLDABLE_EARNING_STATUSES, EarningStatus.HELD] },
    },
    select: { id: true },
  });
  const placed = await placeEarningsHolds(
    tx,
    "consultant",
    holdable.map((r) => r.id),
    { reason: EarningsHoldReason.MODERATION, sourceRef: targetUserId },
  );
  return placed.length;
}

/** Ends the user's collaborations; returns the plans whose team they were on. */
async function endCollaborationsAsModeration(
  tx: Tx,
  targetUserId: string,
  staffUserId: string,
): Promise<PlanRef[]> {
  const ended = await endCollaborationsForUser(tx, targetUserId, {
    endedByUserId: staffUserId,
  });
  return ended.filter((e) => e.wasOnTeam).map((e) => e.ref);
}

async function unverifyProfiles(
  tx: Tx,
  targetUserId: string,
  staffUserId: string,
): Promise<TransactionalEffectResult> {
  // Both fields: explore + the booking gate filter on verificationStatus,
  // while isVerified is the projected display flag.
  const updated = await tx.consultantProfile.updateMany({
    where: { userId: targetUserId },
    data: { isVerified: false, verificationStatus: "REJECTED" },
  });
  // Only a verified expert holds a place on a team.
  const teams = await endCollaborationsAsModeration(
    tx,
    targetUserId,
    staffUserId,
  );
  return {
    profilesUnverified: updated.count,
    ...(teams.length > 0 ? { collaborationsRemoved: teams } : {}),
  };
}

async function softDeleteReview(
  tx: Tx,
  reviewId: string | null,
): Promise<TransactionalEffectResult> {
  if (!reviewId) return {};
  const review = await tx.consultantReview.findUnique({
    where: { id: reviewId },
    select: { consultantProfileId: true, deletedAt: true, removedBy: true },
  });
  if (!review) return {};
  // Already taken down by moderation: nothing to do. An AUTHOR's withdrawal is
  // not a takedown — it is revivable — so moderation still stamps itself over
  // it, or the author could revive content staff resolved as removed. The actor
  // and reason are the report's ModerationAction row (#1562).
  if (review.deletedAt && review.removedBy === "MODERATION") return {};
  // CAS'd in the WHERE rather than trusting the read above.
  const removed = await tx.consultantReview.updateMany({
    where: { id: reviewId, OR: [{ deletedAt: null }, { removedBy: "AUTHOR" }] },
    data: { deletedAt: new Date(), removedBy: "MODERATION" },
  });
  if (removed.count === 0) return {};
  // #705 — one implementation of the rating rule, never an inlined `_avg`.
  await recomputeConsultantRating(tx, review.consultantProfileId);
  return {
    reviewRemoved: true,
    reviewRemovedConsultantProfileId: review.consultantProfileId,
  };
}

async function excludeReviewFromAggregate(
  tx: Tx,
  report: ModerationReportRef,
): Promise<TransactionalEffectResult> {
  const { reviewId } = report;
  if (!reviewId) return {};
  const review = await tx.consultantReview.findUnique({
    where: { id: reviewId },
    select: {
      consultantProfileId: true,
      consultantProfile: { select: { userId: true } },
    },
  });
  if (!review) {
    throw Object.assign(
      new Error("This review is already excluded or removed"),
      { httpStatus: 409 },
    );
  }
  const updated = await tx.consultantReview.updateMany({
    where: {
      id: reviewId,
      excludedFromAggregateAt: null,
      deletedAt: null,
    },
    data: { excludedFromAggregateAt: new Date() },
  });
  if (updated.count === 0) {
    throw Object.assign(
      new Error("This review is already excluded or removed"),
      { httpStatus: 409 },
    );
  }
  await recomputeConsultantRating(tx, review.consultantProfileId);
  const expertUserId = review.consultantProfile.userId;
  const statementReason = moderationStatementOfReasons({
    actionType: "REVIEW_EXCLUDED_FROM_AGGREGATE",
    reportId: report.id,
    reportReason: report.reason,
  });
  const dashboardUrl = goHref("expert", "reviews");
  const excludedBell = await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.REVIEW_EXCLUDED_FROM_RATING,
    recipients: [expertUserId],
    payload: {
      reviewId,
      reference: formatReportReference(report.id),
      reason: statementReason,
      dashboardUrl,
    },
    dedupeKey: `review-excluded:${reviewId}`,
  });
  const excludedRows = await stageAccountModerationEmail(tx, {
    userId: expertUserId,
    kind: "REVIEW_EXCLUDED",
    reason: statementReason,
    dashboardUrl,
  });
  return {
    reviewExcludedFromAggregate: true,
    reviewRemovedConsultantProfileId: review.consultantProfileId,
    expertUserId,
    stagedBells: excludedBell ? [excludedBell] : [],
    stagedEmails: [
      { rows: excludedRows, emailType: "REVIEW_EXCLUDED_FROM_RATING" },
    ],
  };
}

async function excludeFeedbackFromAggregate(
  tx: Tx,
  feedbackId: string | null | undefined,
): Promise<TransactionalEffectResult> {
  if (!feedbackId) return {};
  const updated = await tx.appointmentFeedback.updateMany({
    where: { id: feedbackId, excludedFromAggregateAt: null },
    data: { excludedFromAggregateAt: new Date() },
  });
  if (updated.count === 0) {
    throw Object.assign(
      new Error("This feedback is already excluded or not found"),
      { httpStatus: 409 },
    );
  }
  return {};
}

type TriggerOutcome = { success: boolean; error?: Error | string } | null;

export async function applyBestEffortEffects(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
): Promise<SideEffectSummary> {
  const { actionType } = input;
  const { stagedSessionEnds = [], ...committed } = transactional;
  // The ban or suspension has committed; a failed log write cannot undo it.
  await stampSessionEnds(stagedSessionEnds);
  const summary: SideEffectSummary = {
    ...committed,
    stagedBells: [...(transactional.stagedBells ?? [])],
    stagedEmails: [...(transactional.stagedEmails ?? [])],
  };
  const errors: string[] = [];

  if (actionType === "USER_SUSPENDED" || actionType === "USER_BANNED") {
    await runBulkCancellations(input, summary, errors);
  }
  if (hasStreamEnforcement(actionType, input.report)) {
    await runStreamStep(input, summary, errors);
  }
  if (transactional.collaborationsRemoved?.length) {
    await runCollaboratorRevocations(
      input.report.targetUserId,
      transactional.collaborationsRemoved,
      summary,
    );
  }

  await runNotification(input, transactional, summary, errors);

  if (errors.length > 0) summary.errors = errors;
  return summary;
}

async function runBulkCancellations(
  input: ModerationSideEffectInput,
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  const { report, staffUserId, notes } = input;
  try {
    summary.cancellations = await cancelFutureEngagementsForUser(
      report.targetUserId,
      { initiatedByUserId: staffUserId, notes },
    );
  } catch (error) {
    errors.push(`cancellations: ${errMsg(error)}`);
    captureModerationError(error);
  }
}

// The Stream side of the collaborations phase 1 ended. Their transaction wrote
// each revocation, so whatever this attempt leaves the revocation sweep finishes.
async function runCollaboratorRevocations(
  targetUserId: string,
  plans: PlanRef[],
  summary: SideEffectSummary,
): Promise<void> {
  // Lazy: a static import would pull the Stream graph into every action.
  const { revokeCollaboratorAccess } =
    await import("@/lib/stream/access-revocation");
  for (const ref of plans) await revokeCollaboratorAccess(ref, targetUserId);
  summary.collaboratorRevocation = "ok";
}

/**
 * #1270 — does this action owe Stream a write at all?
 *
 * Also the sweep's filter: an action with no Stream step must never be picked
 * up for retry, and a CONTENT_REMOVED on a review has nothing to delete there.
 */
export function hasStreamEnforcement(
  actionType: ModerationActionType,
  report: ModerationReportRef,
): boolean {
  if (actionType === "USER_BANNED" || actionType === "USER_SUSPENDED") {
    return true;
  }
  return (
    actionType === "CONTENT_REMOVED" &&
    report.type === "MESSAGE" &&
    Boolean(report.streamMessageId)
  );
}

/**
 * The single Stream write an action owes, isolated from the bookkeeping around
 * it so the retry sweep re-drives exactly this and nothing else (#1270).
 *
 * Every branch is idempotent, which is what makes a blind retry safe:
 * re-revoking moves a timestamp that is already in the past, re-deactivating an
 * inactive user is a no-op, and a message that is already gone is the outcome
 * we wanted.
 */
export async function applyStreamEnforcement(
  actionType: ModerationActionType,
  report: ModerationReportRef,
): Promise<void> {
  await withStreamCircuitBreaker(async () => {
    const chat = getStreamChatClient();
    if (actionType === "CONTENT_REMOVED") {
      await deleteReportedMessage(chat, report);
      return;
    }
    // revokeUserToken sets revoke_tokens_issued_before = now, which invalidates
    // every token issued BEFORE that instant. A suspension therefore self-heals:
    // once banExpires passes, the token provider mints a fresh token whose `iat`
    // is later than the revoke timestamp, and Stream accepts it.
    //
    // That was only true after #1134 P0-4. Chat tokens used to be minted with no
    // `iat` at all, and Stream treats an iat-less token as INVALID whenever
    // revocation is active — so every future token was rejected too and a 7-day
    // suspension was permanent. lib/stream-client.ts now always sets `iat`.
    await chat.revokeUserToken(report.targetUserId, new Date());
    if (actionType === "USER_BANNED") {
      // Deactivated users cannot connect at all; history is preserved.
      // Permanent by design — USER_BANNED sets banExpires null. Lifting one
      // is an explicit act and must call restoreStreamAccess below.
      await chat.deactivateUser(report.targetUserId, {
        mark_messages_deleted: false,
      });
    }
  });
}

async function deleteReportedMessage(
  chat: ReturnType<typeof getStreamChatClient>,
  report: ModerationReportRef,
): Promise<void> {
  if (!report.streamMessageId) return;
  try {
    // Soft delete: Stream keeps the row and stops serving the text, so the
    // evidence survives an appeal while the channel stops showing the abuse.
    // A hard delete would destroy the only copy of what was moderated.
    await chat.deleteMessage(report.streamMessageId);
  } catch (error) {
    // A message Stream cannot find is already gone — the state this step
    // exists to reach — and that is the normal answer when the sweep re-drives
    // a step that actually succeeded, or when the author deleted it first.
    // Stream answers with the 404/code-16 shape isExpectedStreamError already
    // recognises as "Stream is up and said no such thing"; an outage never
    // looks like this, so nothing real is being swallowed.
    if (isExpectedStreamError(error)) return;
    throw error;
  }
}

async function runStreamStep(
  input: ModerationSideEffectInput,
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  const { actionType, report } = input;
  try {
    await applyStreamEnforcement(actionType, report);
    summary.stream = "ok";
  } catch (error) {
    summary.stream = "failed";
    summary.streamAttempts = 1;
    errors.push(`${streamErrorPrefix(actionType)}: ${errMsg(error)}`);
    captureModerationError(error);
  }
}

/** Which Stream step failed — the two are indistinguishable from `stream` alone. */
export function streamErrorPrefix(actionType: ModerationActionType): string {
  return actionType === "CONTENT_REMOVED" ? "message-delete" : "stream";
}

/**
 * Best-effort persistence of the side-effect summary, which is what staff read
 * and what the retry sweep drains. A failure here is captured but never
 * surfaced to the caller: the enforcement itself already happened, and failing
 * the request would invite a retry that the 409 idempotency guard would refuse.
 */
export async function persistActionSideEffects(
  actionId: string,
  sideEffects: SideEffectSummary,
): Promise<void> {
  const write = () =>
    prisma.moderationAction.update({
      where: { id: actionId },
      // NOT structuredClone (Sonar S7784): this is a SERIALIZATION, not a
      // deep clone. `SideEffectSummary` has five optional fields, and Prisma's
      // InputJsonValue rejects `undefined` in an object — the JSON round-trip
      // strips those keys, structuredClone would preserve them.
      data: { sideEffects: JSON.parse(JSON.stringify(sideEffects)) },
    });

  try {
    await write();
  } catch (first) {
    // #1270 review — this row IS the outbox. `retry-moderation-enforcement`
    // selects on `sideEffects.stream === "failed"`, so losing this write does
    // not merely lose a status field: it loses the queue entry, and a ban that
    // never reached Stream is then never retried and never surfaced. Swallowing
    // it, as this used to, made the one durable record of an unlanded
    // enforcement the most disposable thing in the flow.
    captureModerationError(first);
    try {
      await write();
    } catch (second) {
      // Both attempts gone. Nothing downstream can recover this, so it is
      // raised at a level a human sees rather than logged and forgotten.
      Sentry.captureException(
        second instanceof Error ? second : new Error(String(second)),
        {
          level: "fatal",
          tags: { subsystem: "moderation", op: "persistActionSideEffects" },
          extra: { actionId, streamOutcome: sideEffects.stream ?? null },
        },
      );
    }
  }
}

async function runNotification(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
  summary: SideEffectSummary,
  errors: string[],
): Promise<void> {
  try {
    // The Novu wrappers are non-throwing (TriggerResult) — read the success
    // flag; the catch only covers unexpected throws.
    const trigger = await triggerModerationNotification(
      input,
      transactional,
      summary,
    );
    if (trigger === null) {
      summary.notification = "skipped";
    } else if (trigger.success) {
      summary.notification = "ok";
    } else {
      summary.notification = "failed";
      errors.push(`notification: ${errMsg(trigger.error ?? "trigger failed")}`);
    }
  } catch (error) {
    summary.notification = "failed";
    errors.push(`notification: ${errMsg(error)}`);
    captureModerationError(error);
  }
}

async function triggerModerationNotification(
  input: ModerationSideEffectInput,
  transactional: TransactionalEffectResult,
  summary: SideEffectSummary,
): Promise<TriggerOutcome> {
  const { actionId, actionType, report } = input;
  const actionSuffix = actionId ?? `${report.id}:${actionType}`;
  const dedupeKey = `moderation-action:${actionSuffix}`;
  const statementReason = moderationStatementOfReasons({
    actionType,
    reportId: report.id,
    reportReason: report.reason,
  });
  switch (actionType) {
    case "WARNING_ISSUED": {
      const bell = await notifyModerationWarning(
        report.targetUserId,
        { reason: statementReason },
        dedupeKey,
        { deferAttempt: true },
      );
      if (bell.staged) summary.stagedBells?.push(bell.staged);
      return bell;
    }
    case "USER_SUSPENDED": {
      const bell = await notifyAccountSuspended(
        report.targetUserId,
        {
          reason: statementReason,
          suspendedUntil: transactional.banExpires ?? "",
          appointmentsCancelled: summary.cancellations?.engagementsCancelled,
        },
        dedupeKey,
        { deferAttempt: true },
      );
      if (bell.staged) summary.stagedBells?.push(bell.staged);
      const suspendedRows = await stageAccountModerationEmail(prisma, {
        userId: report.targetUserId,
        kind: "SUSPENDED",
        reason: statementReason,
        suspendedUntil: transactional.banExpires,
        appointmentsCancelled: summary.cancellations?.engagementsCancelled,
        supportUrl: "/support",
      }).catch((err) => {
        console.error(
          "[moderation] Failed to stage ACCOUNT_SUSPENDED email:",
          err,
        );
        return [];
      });
      summary.stagedEmails?.push({
        rows: suspendedRows,
        emailType: "ACCOUNT_SUSPENDED",
      });
      return bell;
    }
    case "USER_BANNED": {
      const bell = await notifyAccountBanned(
        report.targetUserId,
        {
          reason: statementReason,
          appointmentsCancelled: summary.cancellations?.engagementsCancelled,
        },
        dedupeKey,
        { deferAttempt: true },
      );
      if (bell.staged) summary.stagedBells?.push(bell.staged);
      const bannedRows = await stageAccountModerationEmail(prisma, {
        userId: report.targetUserId,
        kind: "BANNED",
        reason: statementReason,
        appointmentsCancelled: summary.cancellations?.engagementsCancelled,
        supportUrl: "/support",
      }).catch((err) => {
        console.error(
          "[moderation] Failed to stage ACCOUNT_BANNED email:",
          err,
        );
        return [];
      });
      summary.stagedEmails?.push({
        rows: bannedRows,
        emailType: "ACCOUNT_BANNED",
      });
      return bell;
    }
    case "PROFILE_UNVERIFIED": {
      const bell = await notifyVerificationStatusChanged(
        report.targetUserId,
        {
          status: "REJECTED",
          reason: statementReason,
          dashboardUrl: goHref("expert", "settings"),
        },
        dedupeKey,
        { deferAttempt: true },
      );
      if (bell.staged) summary.stagedBells?.push(bell.staged);
      return bell;
    }
    case "NO_ACTION":
    case "USER_REINSTATED":
    case "REVIEW_REPLY_REMOVED":
    case "CONTENT_REMOVED":
    case "REVIEW_REMOVED":
    case "REVIEW_EXCLUDED_FROM_AGGREGATE":
    case "FEEDBACK_EXCLUDED_FROM_AGGREGATE":
    case "REVIEW_RESTORED":
    case "REVIEW_REPLY_RESTORED":
    case "RATING_REINSTATED":
      // A restoration is the inverse of a removal, so it raises no bell.
      return Promise.resolve(null);
  }
}

/**
 * #1134 P0-4 — the inverse of runStreamRevocation, for when a ban is lifted.
 *
 * A USER_BANNED action calls `deactivateUser`, which is permanent: a deactivated
 * user cannot connect to Stream at all, and nothing in this codebase ever undid
 * it. That is correct while the ban stands, but if an operator lifts a permanent
 * ban the account is left unable to chat with no visible cause.
 *
 * `revokeUserToken(id, null)` is belt-and-braces. Tokens now carry `iat`, so a
 * freshly-minted one already post-dates the revoke timestamp and would be
 * accepted regardless — clearing the flag just removes a trap for anyone who
 * later reintroduces an iat-less token.
 *
 * Idempotent: reactivating a live user and clearing an unset revocation are both
 * no-ops on Stream's side. Callers should invoke this from whatever unban path
 * they build; there is no automated one today because USER_SUSPENDED expires
 * lazily at sign-in without ever deactivating.
 */
/**
 * Is this the benign "that user was never deactivated" response?
 *
 * Stream documents neither outcome for `reactivateUser` on an active user — not
 * that it errors, not that it is a no-op — so this matches narrowly and lets
 * everything else through. The asymmetry is deliberate: swallowing the
 * already-active case costs nothing, because the account is already in the state
 * we wanted. Swallowing a timeout, a 429 or a 5xx would report a successful
 * restore for an account that is still deactivated and still unable to chat,
 * which is precisely how P0-4 stayed invisible for months.
 *
 * Stream's `ErrorFromResponse` carries `status`; a network or timeout failure
 * carries none, so it falls through to the rethrow.
 */
function isAlreadyActiveResponse(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  return /not deactivated|already active/i.test(errMsg(error));
}

export async function restoreStreamAccess(userId: string): Promise<void> {
  await withStreamCircuitBreaker(async () => {
    const chat = getStreamChatClient();
    await chat.revokeUserToken(userId, null);
    try {
      await chat.reactivateUser(userId);
    } catch (error) {
      // A lifted SUSPENSION only ever revoked tokens, never deactivated, so
      // "was not deactivated" is the normal shape there and is a SUCCESS — the
      // un-revoke above is the part that mattered for that case. Reporting it
      // would page on the healthy path, which is how a real signal gets tuned
      // out. Every other failure means the account is still locked out of chat,
      // so it is both reported and propagated.
      if (isAlreadyActiveResponse(error)) return;
      captureModerationError(error);
      throw error;
    }
  });
}
