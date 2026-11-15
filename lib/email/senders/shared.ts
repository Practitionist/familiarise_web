import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import prisma, { type Tx } from "@/lib/prisma";
import type { PreferenceCategory } from "@/lib/novu/templates/types";
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";
import { getAppUrl } from "@/lib/url";
import { formatCurrencyAmount } from "@/utils/formatting";
import { EMAIL_BUDGET_MS, SENDERS } from "../config";
import { loadEmailRecipients, type EmailRecipient } from "../preferences";
import {
  attemptStaged,
  prepareRecipientEmails,
  sendToRecipients,
  stagePreparedEmails,
  type PreparedRecipientEmails,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
} from "../send-to-recipients";

export {
  attemptStaged,
  prepareRecipientEmails,
  stagePreparedEmails,
  type PreparedRecipientEmails,
};

export type Paise = number | bigint;
export type StagingTx = Pick<Tx, "failedEmail" | "emailSuppression" | "user">;

export interface RecipientEmailSpec {
  emailType: string;
  category: PreferenceCategory | null;
  from?: string;
  entityRef: string;
  subject: (r: EmailRecipient) => string;
  render: (r: EmailRecipient) => ReactElement;
  /** A required notice: a render failure stages a `review:render_failed` row in its place, not a Sentry event. */
  traceRenderFailure?: boolean;
  /** Recipients this send is required for (`lib/notifications/required-notices.ts`). */
  requiredFor?: readonly string[];
}

export type SpecBuild<TArgs> = (args: TArgs) => {
  userIds: string[];
  spec: RecipientEmailSpec;
};

/** Messages rendered before a transaction, bound to the exact inputs that produced them. */
export interface PreparedSpecEmails {
  key: string;
  prepared: PreparedRecipientEmails;
}

export interface StagedOnboardingEmail {
  emailType: string;
  budgetMs: number;
  list: StagedRecipientEmail[];
}

const WHEN_PATTERN = "EEE, d MMM yyyy 'at' h:mm a";
const DATE_PATTERN = "d MMM yyyy";
const FAILED: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 1 };

export function greet(r: EmailRecipient): string {
  return r.name?.trim() || "there";
}

export function absolute(href: string): string {
  return href.startsWith("/") ? `${getAppUrl()}${href}` : href;
}

export function whenText(date: Date | string, zone: string): string {
  return `${formatInViewerZone(date, zone, WHEN_PATTERN)} ${zoneLabel(date, zone)}`;
}

export function dateText(date: Date | string, zone: string): string {
  return formatInViewerZone(date, zone, DATE_PATTERN);
}

export function money(amountPaise: Paise, currency: string): string {
  return formatCurrencyAmount(Number(amountPaise), currency);
}

export async function prepareSpecEmails(
  spec: RecipientEmailSpec,
  userIds: string[],
  db?: StagingTx,
): Promise<PreparedRecipientEmails> {
  const traced = spec.traceRenderFailure === true;
  const recipients = await loadEmailRecipients(
    userIds,
    spec.category,
    db,
    spec.requiredFor,
  );
  return prepareRecipientEmails(
    {
      recipients,
      emailType: spec.emailType,
      from: spec.from ?? SENDERS.notifications,
      subject: spec.subject,
      render: spec.render,
      entityRef: spec.entityRef,
    },
    { reportToSentry: !traced, traceFailures: traced },
  );
}

function inputKey(args: unknown): string {
  return JSON.stringify(args, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** Renders `build(args)` outside any transaction, for `stageBuiltSpec` to stage inside one. */
export async function prepareBuiltSpec<TArgs>(
  build: SpecBuild<TArgs>,
  args: TArgs,
): Promise<PreparedSpecEmails> {
  const { userIds, spec } = build(args);
  return {
    key: inputKey(args),
    prepared: await prepareSpecEmails(spec, userIds),
  };
}

/**
 * Stages `pre` inside `tx` when it was rendered from these exact `args`;
 * otherwise renders here, where a render failure stages nothing and never throws.
 */
export async function stageBuiltSpec<TArgs>(
  tx: StagingTx,
  build: SpecBuild<TArgs>,
  args: TArgs,
  pre?: PreparedSpecEmails | null,
): Promise<StagedRecipientEmail[]> {
  const { userIds, spec } = build(args);
  if (
    pre &&
    pre.prepared.emailType === spec.emailType &&
    pre.key === inputKey(args)
  ) {
    return stagePreparedEmails(tx, pre.prepared);
  }
  return stageSpecGuarded(spec, userIds, tx);
}

export async function sendSpecGuarded(
  spec: RecipientEmailSpec,
  userIds: string[],
  budgetMs: number,
  fallback: SendToRecipientsResult = FAILED,
  deferAttempt?: boolean,
): Promise<SendToRecipientsResult> {
  try {
    const recipients = await loadEmailRecipients(
      userIds,
      spec.category,
      undefined,
      spec.requiredFor,
    );
    return await sendToRecipients({
      recipients,
      emailType: spec.emailType,
      from: spec.from ?? SENDERS.notifications,
      subject: spec.subject,
      render: spec.render,
      entityRef: spec.entityRef,
      budgetMs,
      ...(deferAttempt ? { deferAttempt: true } : {}),
      ...(spec.traceRenderFailure ? { traceFailures: true } : {}),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType: spec.emailType } },
    );
    console.error(`[email] ${spec.emailType} failed:`, error);
    return fallback;
  }
}

/** Renders and stages `spec` in `tx`; a render failure stages nothing (or its trace row) and never throws. */
export async function stageSpecGuarded(
  spec: RecipientEmailSpec,
  userIds: string[],
  tx?: StagingTx,
): Promise<StagedRecipientEmail[]> {
  const db = tx ?? prisma;
  const prepared = await prepareSpecEmails(spec, userIds, db);
  return stagePreparedEmails(db, prepared);
}

/** One `IdempotencyRecord` per (scope, key, recipient) makes a staged email at-most-once. */
export interface RecipientClaim {
  scope: string;
  key: (userId: string) => string;
  ttlMs: number;
}

/**
 * Stage `spec` for each recipient not already claimed under `claim`. Renders
 * outside the transaction; each claim commits with its staged row, so a lost
 * race or a repeat stages nothing.
 */
export async function stageSpecOncePerRecipient(
  spec: RecipientEmailSpec,
  userIds: string[],
  claim: RecipientClaim,
): Promise<StagedRecipientEmail[]> {
  return (await stageOncePerRecipient(spec, userIds, claim, true)).staged;
}

/**
 * {@link stageSpecOncePerRecipient} for a sweep: it never reports a render
 * failure per row, and returns the count for the caller to report once per run.
 */
export async function stageSpecOncePerRecipientQuietly(
  spec: RecipientEmailSpec,
  userIds: string[],
  claim: RecipientClaim,
): Promise<{ staged: StagedRecipientEmail[]; renderFailures: number }> {
  return stageOncePerRecipient(spec, userIds, claim, false);
}

async function stageOncePerRecipient(
  spec: RecipientEmailSpec,
  userIds: string[],
  claim: RecipientClaim,
  reportToSentry: boolean,
): Promise<{ staged: StagedRecipientEmail[]; renderFailures: number }> {
  const recipients = await loadEmailRecipients(
    userIds,
    spec.category,
    undefined,
    spec.requiredFor,
  );
  if (recipients.length === 0) return { staged: [], renderFailures: 0 };
  const taken = await prisma.idempotencyRecord.findMany({
    where: {
      scope: claim.scope,
      key: { in: recipients.map((r) => claim.key(r.userId)) },
    },
    select: { userId: true },
  });
  const takenIds = new Set(taken.map((t) => t.userId));
  const pending: { userId: string; prepared: PreparedRecipientEmails }[] = [];
  let renderFailures = 0;
  for (const recipient of recipients) {
    if (takenIds.has(recipient.userId)) continue;
    const prepared = await prepareRecipientEmails(
      {
        recipients: [recipient],
        emailType: spec.emailType,
        from: spec.from ?? SENDERS.notifications,
        subject: spec.subject,
        render: spec.render,
        entityRef: spec.entityRef,
      },
      { reportToSentry },
    );
    renderFailures += prepared.failed;
    if (prepared.messages.length > 0) {
      pending.push({ userId: recipient.userId, prepared });
    }
  }
  if (pending.length === 0) return { staged: [], renderFailures };

  const staged = await prisma.$transaction((tx) =>
    claimAndStagePrepared(tx, claim, pending),
  );
  return { staged, renderFailures };
}

/**
 * Inside the caller's transaction, claim each recipient under `claim` and stage
 * their pre-rendered email only where the claim is new, so a re-run stages nothing.
 */
export async function claimAndStagePrepared(
  tx: Pick<Tx, "idempotencyRecord" | "failedEmail" | "emailSuppression">,
  claim: RecipientClaim,
  prepared: { userId: string; prepared: PreparedRecipientEmails }[],
): Promise<StagedRecipientEmail[]> {
  const pending = prepared.filter((p) => p.prepared.messages.length > 0);
  if (pending.length === 0) return [];
  const now = new Date();
  const claimed = await tx.idempotencyRecord.createManyAndReturn({
    data: pending.map(({ userId }) => ({
      scope: claim.scope,
      key: claim.key(userId),
      userId,
      requestHash: claim.key(userId),
      completedAt: now,
      expiresAt: new Date(now.getTime() + claim.ttlMs),
    })),
    skipDuplicates: true,
    select: { userId: true },
  });
  const won = new Set(claimed.map((c) => c.userId));
  const staged: StagedRecipientEmail[] = [];
  for (const { userId, prepared: emails } of pending) {
    if (won.has(userId))
      staged.push(...(await stagePreparedEmails(tx, emails)));
  }
  return staged;
}

export function defineBudgetedEmailSender<TArgs>(
  build: (args: TArgs) => { userIds: string[]; spec: RecipientEmailSpec },
  fallback?: SendToRecipientsResult,
  defaultBudgetMs: number = EMAIL_BUDGET_MS.REQUEST,
) {
  return (
    args: TArgs,
    budgetOrOpts?: number | { budgetMs?: number; deferAttempt?: boolean },
  ): Promise<SendToRecipientsResult> => {
    const { userIds, spec } = build(args);
    const budgetMs =
      typeof budgetOrOpts === "number"
        ? budgetOrOpts
        : (budgetOrOpts?.budgetMs ?? defaultBudgetMs);
    const deferAttempt =
      typeof budgetOrOpts === "number" ? undefined : budgetOrOpts?.deferAttempt;
    return sendSpecGuarded(spec, userIds, budgetMs, fallback, deferAttempt);
  };
}

export function defineFixedBudgetEmailSender<TArgs>(
  budgetMs: number,
  build: (args: TArgs) => { userIds: string[]; spec: RecipientEmailSpec },
  fallback?: SendToRecipientsResult,
) {
  return (args: TArgs): Promise<SendToRecipientsResult> => {
    const { userIds, spec } = build(args);
    return sendSpecGuarded(spec, userIds, budgetMs, fallback);
  };
}

function isPrismaLike(val: unknown): val is StagingTx {
  return (
    typeof val === "object" &&
    val !== null &&
    ("$transaction" in val || "failedEmail" in val || "user" in val)
  );
}

export function defineLifecycleStager<TArgs extends object>(
  build: SpecBuild<TArgs>,
) {
  function stageEmail(
    tx: StagingTx,
    args: TArgs,
    pre?: PreparedSpecEmails | null,
  ): Promise<StagedRecipientEmail[]>;
  function stageEmail(
    args: TArgs,
    tx?: StagingTx,
  ): Promise<StagedRecipientEmail[]>;
  async function stageEmail(
    first: StagingTx | TArgs,
    second?: TArgs | StagingTx,
    pre?: PreparedSpecEmails | null,
  ): Promise<StagedRecipientEmail[]> {
    const isTxFirst =
      second !== undefined ? !isPrismaLike(second) : isPrismaLike(first);
    if (isTxFirst) {
      return stageBuiltSpec(first as StagingTx, build, second as TArgs, pre);
    }
    const tx = isPrismaLike(second) ? second : undefined;
    const { userIds, spec } = build(first as TArgs);
    return stageSpecGuarded(spec, userIds, tx);
  }
  return stageEmail;
}

/** The before-the-transaction half of a `defineLifecycleStager` stager. */
export function defineLifecyclePreparer<TArgs extends object>(
  build: SpecBuild<TArgs>,
) {
  return (args: TArgs): Promise<PreparedSpecEmails> =>
    prepareBuiltSpec(build, args);
}

export function defineStagedEmailSender<TArgs extends object>(
  budgetMs: number,
  build: SpecBuild<TArgs>,
) {
  function stageEmail(
    args: TArgs,
    tx?: StagingTx,
  ): Promise<StagedOnboardingEmail>;
  function stageEmail(
    tx: StagingTx,
    args: TArgs,
    pre?: PreparedSpecEmails | null,
  ): Promise<StagedOnboardingEmail>;
  async function stageEmail(
    first: TArgs | StagingTx,
    second?: StagingTx | TArgs,
    pre?: PreparedSpecEmails | null,
  ): Promise<StagedOnboardingEmail> {
    const isTxFirst =
      second !== undefined ? !isPrismaLike(second) : isPrismaLike(first);
    const tx = isTxFirst
      ? (first as StagingTx)
      : isPrismaLike(second)
        ? second
        : undefined;
    const args = (isTxFirst ? second : first) as TArgs;
    const { userIds, spec } = build(args);
    const run = async (): Promise<StagedOnboardingEmail> => ({
      emailType: spec.emailType,
      budgetMs,
      list: tx
        ? await stageBuiltSpec(tx, build, args, pre)
        : await stageSpecGuarded(spec, userIds),
    });
    if (tx) return run();
    try {
      return await run();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "email", emailType: spec.emailType } },
      );
      console.error(`[email] ${spec.emailType} stage failed:`, error);
      return { emailType: spec.emailType, budgetMs, list: [] };
    }
  }
  return stageEmail;
}
