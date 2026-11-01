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
  stageToRecipients,
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
): Promise<PreparedRecipientEmails> {
  const recipients = await loadEmailRecipients(userIds, spec.category);
  return prepareRecipientEmails({
    recipients,
    emailType: spec.emailType,
    from: spec.from ?? SENDERS.notifications,
    subject: spec.subject,
    render: spec.render,
    entityRef: spec.entityRef,
  });
}

export async function sendSpecGuarded(
  spec: RecipientEmailSpec,
  userIds: string[],
  budgetMs: number,
  fallback: SendToRecipientsResult = FAILED,
  deferAttempt?: boolean,
): Promise<SendToRecipientsResult> {
  try {
    const recipients = await loadEmailRecipients(userIds, spec.category);
    return await sendToRecipients({
      recipients,
      emailType: spec.emailType,
      from: spec.from ?? SENDERS.notifications,
      subject: spec.subject,
      render: spec.render,
      entityRef: spec.entityRef,
      budgetMs,
      ...(deferAttempt ? { deferAttempt: true } : {}),
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

export async function stageSpecGuarded(
  spec: RecipientEmailSpec,
  userIds: string[],
  tx?: StagingTx,
): Promise<StagedRecipientEmail[]> {
  const db = tx ?? prisma;
  const recipients = await loadEmailRecipients(userIds, spec.category, db);
  return stageToRecipients({
    tx: db,
    recipients,
    emailType: spec.emailType,
    from: spec.from ?? SENDERS.notifications,
    subject: spec.subject,
    render: spec.render,
    entityRef: spec.entityRef,
  });
}

/**
 * Stages `spec` in `tx`; a render failure throws so the caller's claim rolls back.
 * No per-recipient Sentry: the caller retries every run and reports its failure count once.
 */
export async function stageSpecRequired(
  tx: StagingTx,
  spec: RecipientEmailSpec,
  userIds: string[],
): Promise<StagedRecipientEmail[]> {
  const recipients = await loadEmailRecipients(userIds, spec.category, tx);
  const prepared = await prepareRecipientEmails(
    {
      recipients,
      emailType: spec.emailType,
      from: spec.from ?? SENDERS.notifications,
      subject: spec.subject,
      render: spec.render,
      entityRef: spec.entityRef,
    },
    { reportToSentry: false },
  );
  if (prepared.failed > 0) {
    throw new Error(
      `${spec.emailType} render failed for ${prepared.failed} recipient(s)`,
    );
  }
  return stagePreparedEmails(tx, prepared);
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
  const recipients = await loadEmailRecipients(userIds, spec.category);
  if (recipients.length === 0) return [];
  const taken = await prisma.idempotencyRecord.findMany({
    where: {
      scope: claim.scope,
      key: { in: recipients.map((r) => claim.key(r.userId)) },
    },
    select: { userId: true },
  });
  const takenIds = new Set(taken.map((t) => t.userId));
  const pending: { userId: string; prepared: PreparedRecipientEmails }[] = [];
  for (const recipient of recipients) {
    if (takenIds.has(recipient.userId)) continue;
    const prepared = await prepareRecipientEmails({
      recipients: [recipient],
      emailType: spec.emailType,
      from: spec.from ?? SENDERS.notifications,
      subject: spec.subject,
      render: spec.render,
      entityRef: spec.entityRef,
    });
    if (prepared.messages.length > 0) {
      pending.push({ userId: recipient.userId, prepared });
    }
  }
  if (pending.length === 0) return [];

  const now = new Date();
  return prisma.$transaction(async (tx) => {
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
    for (const { userId, prepared } of pending) {
      if (won.has(userId))
        staged.push(...(await stagePreparedEmails(tx, prepared)));
    }
    return staged;
  });
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
  build: (args: TArgs) => { userIds: string[]; spec: RecipientEmailSpec },
) {
  function stageEmail(
    tx: StagingTx,
    args: TArgs,
  ): Promise<StagedRecipientEmail[]>;
  function stageEmail(
    args: TArgs,
    tx?: StagingTx,
  ): Promise<StagedRecipientEmail[]>;
  async function stageEmail(
    first: StagingTx | TArgs,
    second?: TArgs | StagingTx,
  ): Promise<StagedRecipientEmail[]> {
    const isTxFirst =
      second !== undefined ? !isPrismaLike(second) : isPrismaLike(first);
    const tx = isTxFirst
      ? (first as StagingTx)
      : isPrismaLike(second)
        ? second
        : undefined;
    const args = (isTxFirst ? second : first) as TArgs;
    const { userIds, spec } = build(args);
    return stageSpecGuarded(spec, userIds, tx);
  }
  return stageEmail;
}

export function defineStagedEmailSender<TArgs extends object>(
  budgetMs: number,
  build: (args: TArgs) => { userIds: string[]; spec: RecipientEmailSpec },
) {
  function stageEmail(
    args: TArgs,
    tx?: StagingTx,
  ): Promise<StagedOnboardingEmail>;
  function stageEmail(
    tx: StagingTx,
    args: TArgs,
  ): Promise<StagedOnboardingEmail>;
  async function stageEmail(
    first: TArgs | StagingTx,
    second?: StagingTx | TArgs,
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
      list: await stageSpecGuarded(spec, userIds, tx),
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
