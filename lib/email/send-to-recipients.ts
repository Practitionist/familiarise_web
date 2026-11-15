/**
 * #1653 — fan a lifecycle email out to the recipients `loadEmailRecipients()`
 * resolved: render per recipient, honour the gate, attach the one-click
 * headers, and hand each message to the send core. Sequential on purpose:
 * PG_POOL_MAX=1 on Netlify serialises the outbox writes anyway.
 */

import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import prisma, { type Tx } from "@/lib/prisma";
import {
  attempt,
  deliver,
  screenForStaging,
  stage,
  stageRenderFailure,
  stageScreened,
  type RenderedEmail,
  type ScreenedEmail,
  type StagedEmail,
  type UnrenderedEmail,
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
  /** A required notice: a render failure writes a `review:render_failed` row, not a Sentry event. */
  traceFailures?: boolean;
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
  /** Recipients whose render failed, kept only when the caller traces failures. */
  unrendered?: UnrenderedEmail[];
}

type Outcome =
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "message"; message: RenderedEmail };

type PrepareArgs = Omit<SendToRecipientsArgs, "budgetMs">;

async function prepare(
  recipient: EmailRecipient,
  args: PrepareArgs,
  reportToSentry: boolean,
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
        deliveryPolicy: {
          userId: recipient.userId,
          category: recipient.category,
        },
        headers: recipient.unsubscribeUrl
          ? listUnsubscribeHeaders(recipient.unsubscribeUrl)
          : undefined,
      },
    };
  } catch (renderError) {
    if (reportToSentry) {
      Sentry.captureException(
        renderError instanceof Error
          ? renderError
          : new Error(String(renderError)),
        { tags: { subsystem: "email", emailType: args.emailType } },
      );
    }
    console.error(`[email] ${args.emailType} render failed:`, renderError);
    return { kind: "failed" };
  }
}

export interface PrepareOptions {
  /** False for a sweep, which reports its failures once per run. */
  reportToSentry?: boolean;
  /** Keep each failed recipient so staging leaves a `review:render_failed` row. */
  traceFailures?: boolean;
}

/**
 * Pre-renders HTML, plain text, and unsubscribe headers in memory outside any DB transaction.
 * A caller that reports `failed` once per run passes `reportToSentry: false`.
 */
export async function prepareRecipientEmails(
  args: PrepareArgs,
  { reportToSentry = true, traceFailures = false }: PrepareOptions = {},
): Promise<PreparedRecipientEmails> {
  const messages: RenderedEmail[] = [];
  const unrendered: UnrenderedEmail[] = [];
  let skipped = 0;
  let failed = 0;
  for (const recipient of args.recipients) {
    const outcome = await prepare(recipient, args, reportToSentry);
    if (outcome.kind === "skipped") {
      skipped += 1;
    } else if (outcome.kind === "failed") {
      failed += 1;
      if (traceFailures) {
        unrendered.push({
          from: args.from,
          to: recipient.email,
          deliveryPolicy: {
            userId: recipient.userId,
            category: recipient.category,
          },
        });
      }
    } else {
      messages.push(outcome.message);
    }
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
    ...(traceFailures ? { unrendered } : {}),
  };
}

/** Persists pre-rendered messages, and a trace row per traced render failure, to `FailedEmail` inside `tx`. */
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
  for (const unrendered of prepared.unrendered ?? []) {
    await stageRenderFailure(
      tx,
      unrendered,
      prepared.emailType,
      prepared.entityRef,
    );
  }
  return list;
}

/** Prepared messages with their hold and suppression verdicts, read before a transaction. */
export interface ScreenedRecipientEmails {
  prepared: PreparedRecipientEmails;
  screened: ScreenedEmail[];
}

/** The reads {@link stagePreparedEmails} makes inside its transaction, made before it in one query. */
export async function screenPreparedEmails(
  prepared: PreparedRecipientEmails,
): Promise<ScreenedRecipientEmails> {
  return {
    prepared,
    screened: await screenForStaging(prepared.messages, prepared.emailType),
  };
}

/** Stages screened messages in one insert, and a trace row per traced render failure, inside `tx`. */
export async function stageScreenedEmails(
  tx: Pick<Tx, "failedEmail">,
  { prepared, screened }: ScreenedRecipientEmails,
  entityRef: string,
): Promise<StagedRecipientEmail[]> {
  const staged = await stageScreened(
    tx,
    screened,
    prepared.emailType,
    entityRef,
  );
  for (const unrendered of prepared.unrendered ?? []) {
    await stageRenderFailure(tx, unrendered, prepared.emailType, entityRef);
  }
  return screened.map(({ message }, i) => ({ staged: staged[i], message }));
}

async function traceSendRenderFailure(
  recipient: EmailRecipient,
  args: SendToRecipientsArgs,
): Promise<void> {
  try {
    await stageRenderFailure(
      prisma,
      {
        from: args.from,
        to: recipient.email,
        deliveryPolicy: {
          userId: recipient.userId,
          category: recipient.category,
        },
      },
      args.emailType,
      args.entityRef,
    );
  } catch (error) {
    console.error(`[email] ${args.emailType} render trace failed:`, error);
  }
}

export async function sendToRecipients(
  args: SendToRecipientsArgs,
): Promise<SendToRecipientsResult> {
  const result: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 0 };
  const stagedEmails: StagedRecipientEmail[] = [];
  for (const recipient of args.recipients) {
    const outcome = await prepare(recipient, args, !args.traceFailures);
    if (outcome.kind === "failed" && args.traceFailures) {
      await traceSendRenderFailure(recipient, args);
    }
    if (outcome.kind !== "message") {
      result[outcome.kind] += 1;
      continue;
    }
    const delivered = await deliver(outcome.message, args.emailType, {
      entityRef: args.entityRef,
      budgetMs: args.budgetMs,
      ...(args.deferAttempt ? { deferAttempt: true } : {}),
    });
    if (args.deferAttempt && (delivered.stagedRow ?? delivered.stagedEmail)) {
      stagedEmails.push({
        staged: delivered.stagedRow ?? delivered.stagedEmail ?? null,
        message: outcome.message,
      });
    }
    if (delivered.success || delivered.staged) result.sent += 1;
    else result.failed += 1;
  }
  if (result.skipped > 0) {
    console.info(
      `[email] skipped ${args.emailType} for ${result.skipped} recipient(s): preference`,
    );
  }
  return args.deferAttempt ? { ...result, stagedEmails } : result;
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
