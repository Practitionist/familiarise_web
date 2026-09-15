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
}

export interface SendToRecipientsResult {
  sent: number;
  skipped: number;
  failed: number;
}

/** A staged row and the message it holds, for `attemptStaged()` after commit. */
export interface StagedRecipientEmail {
  staged: StagedEmail | null;
  message: RenderedEmail;
}

type Outcome =
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "message"; message: RenderedEmail };

type PrepareArgs = Omit<SendToRecipientsArgs, "budgetMs">;

// One place decides skip / render-failure / message so the inline and the
// transactional fan-outs cannot disagree about the gate or the headers.
async function prepare(
  recipient: EmailRecipient,
  args: PrepareArgs,
): Promise<Outcome> {
  if (!recipient.allowed) {
    console.info(
      `[email] skipped ${args.emailType} for user ${recipient.userId}: preference`,
    );
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
    Sentry.captureException(
      renderError instanceof Error
        ? renderError
        : new Error(String(renderError)),
      { tags: { subsystem: "email", emailType: args.emailType } },
    );
    console.error(`[email] ${args.emailType} render failed:`, renderError);
    return { kind: "failed" };
  }
}

export async function sendToRecipients(
  args: SendToRecipientsArgs,
): Promise<SendToRecipientsResult> {
  const result: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 0 };
  for (const recipient of args.recipients) {
    const outcome = await prepare(recipient, args);
    if (outcome.kind !== "message") {
      result[outcome.kind] += 1;
      continue;
    }
    const delivered = await deliver(outcome.message, args.emailType, {
      entityRef: args.entityRef,
      budgetMs: args.budgetMs,
    });
    // A timed-out or transiently failed send is still staged for the relay;
    // only a message that reached neither Resend nor the outbox counts failed.
    if (delivered.success || delivered.staged) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}

/**
 * The transaction owner's twin of `sendToRecipients()`: stage every allowed
 * recipient's message inside `tx`, then call `attemptStaged()` after commit.
 * A render failure is reported and dropped; a staging failure propagates so
 * the transaction rolls back with it.
 */
export async function stageToRecipients(
  args: PrepareArgs & { tx: Pick<Tx, "failedEmail"> },
): Promise<StagedRecipientEmail[]> {
  const list: StagedRecipientEmail[] = [];
  for (const recipient of args.recipients) {
    const outcome = await prepare(recipient, args);
    if (outcome.kind !== "message") continue;
    const staged = await stage(outcome.message, args.emailType, {
      tx: args.tx,
      entityRef: args.entityRef,
    });
    list.push({ staged, message: outcome.message });
  }
  return list;
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
