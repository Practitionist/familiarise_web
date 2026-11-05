/**
 * #1653 — fan a lifecycle email out to the recipients `loadEmailRecipients()`
 * resolved: render per recipient, honour the gate, attach the one-click
 * headers, and hand each message to the send core. Sequential on purpose:
 * PG_POOL_MAX=1 on Netlify serialises the outbox writes anyway.
 */

import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import type { Tx } from "@/lib/prisma";
import {
  attempt,
  deliver,
  stage,
  type RenderedEmail,
  type StagedEmail,
} from "./deliver";
import type { EmailRecipient } from "./preferences";
import { renderEmail } from "./render";
import { listUnsubscribeHeaders } from "./unsubscribe";

export interface SendToRecipientsArgs {
  recipients: EmailRecipient[];
  emailType: string;
  from: string;
  subject: (recipient: EmailRecipient) => string;
  render: (recipient: EmailRecipient) => ReactElement;
  entityRef: string;
  budgetMs: number;
  replyTo?: string;
  deferAttempt?: boolean;
}

export interface SendToRecipientsResult {
  sent: number;
  skipped: number;
  failed: number;
  stagedEmails?: StagedRecipientEmail[];
}

/** A staged row and the message it holds, for `attemptStaged()` after commit. */
export interface StagedRecipientEmail {
  staged: StagedEmail | null;
  message: RenderedEmail;
}

/** Pre-rendered messages ready to stage inside a short database transaction. */
export interface PreparedRecipientEmails {
  emailType: string;
  entityRef: string;
  messages: RenderedEmail[];
  skipped: number;
  failed: number;
}

type Outcome =
  | { kind: "skipped" }
  | { kind: "failed"; error: unknown }
  | { kind: "message"; message: RenderedEmail };

function reportRenderFailures(
  error: unknown,
  emailType: string,
  failed: number,
): void {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    {
      tags: { subsystem: "email", emailType },
      extra: { failedRecipients: failed },
    },
  );
}

type PrepareArgs = Omit<SendToRecipientsArgs, "budgetMs">;

async function prepare(
  recipient: EmailRecipient,
  args: PrepareArgs,
): Promise<Outcome> {
  if (!recipient.allowed) {
    return { kind: "skipped" };
  }
  try {
    const { html, text } = await renderEmail(args.render(recipient));
    return {
      kind: "message",
      message: {
        from: args.from,
        to: recipient.email,
        subject: args.subject(recipient),
        html,
        text,
        replyTo: args.replyTo,
        headers: recipient.unsubscribeUrl
          ? listUnsubscribeHeaders(recipient.unsubscribeUrl)
          : undefined,
      },
    };
  } catch (renderError) {
    console.error(`[email] ${args.emailType} render failed:`, renderError);
    return { kind: "failed", error: renderError };
  }
}

/**
 * Pre-renders HTML, plain text, and unsubscribe headers in memory outside any DB transaction.
 * A caller that reports `failed` once per run passes `reportToSentry: false`.
 */
export async function prepareRecipientEmails(
  args: PrepareArgs,
  { reportToSentry = true }: { reportToSentry?: boolean } = {},
): Promise<PreparedRecipientEmails> {
  const messages: RenderedEmail[] = [];
  let skipped = 0;
  let failed = 0;
  let firstError: unknown;
  for (const recipient of args.recipients) {
    const outcome = await prepare(recipient, args);
    if (outcome.kind === "skipped") {
      skipped += 1;
    } else if (outcome.kind === "failed") {
      failed += 1;
      firstError ??= outcome.error;
    } else {
      messages.push(outcome.message);
    }
  }
  if (failed > 0 && reportToSentry) {
    reportRenderFailures(firstError, args.emailType, failed);
  }
  if (skipped > 0) {
    console.info(
      `[email] skipped ${args.emailType} for ${skipped} recipient(s): preference`,
    );
  }
  return {
    emailType: args.emailType,
    entityRef: args.entityRef,
    messages,
    skipped,
    failed,
  };
}

/** Persists pre-rendered messages to `FailedEmail` inside `tx`. */
export async function stagePreparedEmails(
  tx: Pick<Tx, "failedEmail" | "emailSuppression">,
  prepared: PreparedRecipientEmails,
): Promise<StagedRecipientEmail[]> {
  const list: StagedRecipientEmail[] = [];
  for (const message of prepared.messages) {
    const staged = await stage(message, prepared.emailType, {
      tx,
      entityRef: prepared.entityRef,
    });
    list.push({ staged, message });
  }
  return list;
}

export async function sendToRecipients(
  args: SendToRecipientsArgs,
): Promise<SendToRecipientsResult> {
  const result: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 0 };
  const stagedEmails: StagedRecipientEmail[] = [];
  const prepared = await prepareRecipientEmails(args);
  result.skipped = prepared.skipped;
  result.failed = prepared.failed;
  for (const message of prepared.messages) {
    const delivered = await deliver(message, args.emailType, {
      entityRef: args.entityRef,
      budgetMs: args.budgetMs,
      ...(args.deferAttempt ? { deferAttempt: true } : {}),
    });
    if (args.deferAttempt && (delivered.stagedRow ?? delivered.stagedEmail)) {
      stagedEmails.push({
        staged: delivered.stagedRow ?? delivered.stagedEmail ?? null,
        message,
      });
    }
    if (delivered.success || delivered.staged) result.sent += 1;
    else result.failed += 1;
  }
  return args.deferAttempt ? { ...result, stagedEmails } : result;
}

/**
 * Stages every allowed recipient's rendered message inside `tx` so callers can
 * invoke `attemptStaged()` post-commit.
 */
export async function stageToRecipients(
  args: PrepareArgs & { tx: Pick<Tx, "failedEmail" | "emailSuppression"> },
): Promise<StagedRecipientEmail[]> {
  const prepared = await prepareRecipientEmails(args);
  return stagePreparedEmails(args.tx, prepared);
}

export async function attemptStaged(
  list: StagedRecipientEmail[],
  emailType: string,
  budgetMs: number,
): Promise<void> {
  for (const { staged, message } of list) {
    await attempt(staged, message, emailType, { budgetMs });
  }
}
