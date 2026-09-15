import * as Sentry from "@sentry/nextjs";
import {
  Resend,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
} from "resend";
import type { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { EMAIL_BUDGET_MS, supportEmail } from "./config";
import { resendErrorText, terminalSendReason } from "./classify";
import { idempotencyKeyFor } from "./idempotency";

// #474 — the already-RENDERED message a sender handed to Resend. We persist
// THIS verbatim (not the sender args) so retry is a re-send, not a re-render.
export interface RenderedEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  // #1653 — List-Unsubscribe and friends. Sent inline only: the row does not
  // persist them, so the relay's resend of a staged row carries none.
  headers?: Record<string, string>;
}

export type DeliverResult =
  | { success: true; data: CreateEmailResponse }
  // #1654 — `staged` tells a caller whether the message is durable in the
  // outbox despite the failed inline send (the contact form answers on it).
  | { success: false; error: unknown; staged?: boolean };

/** #1654 — the outbox row `stage()` wrote; `attempt()` settles it. */
export interface StagedEmail {
  id: string;
  idempotencyKey: string;
}

export interface StageOptions {
  /** Stage inside the caller's transaction so a rollback takes the row too. */
  tx?: Pick<Tx, "failedEmail">;
  /** `payment:<id>`, `user:<id>`, `waitlist:<email>`, `contact:<email>`. */
  entityRef?: string;
}

export interface DeliverOptions {
  entityRef?: string;
  /** Inline send budget; defaults to the auth budget, the most generous one. */
  budgetMs?: number;
}

// #1298 — thrown INSIDE deliver's try so a missing key dead-letters the
// message instead of silently returning; the row replays once the key exists.
export class EmailNotConfiguredError extends Error {
  constructor(message = "RESEND_API_KEY is not configured") {
    super(message);
    this.name = "EmailNotConfiguredError";
  }
}

let resendClient: Resend | null = null;

// Lazy singleton so importing the module never touches the env at build time.
export function getResendClient(): Resend | null {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.warn(
      "WARNING: RESEND_API_KEY is not defined. Email functionality will not work.",
    );
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
  }

  return resendClient;
}

// Customers reply to a real mailbox unless the sender chose its own (the
// contact inquiry keeps the visitor's address). Idempotent, so stage and
// attempt derive the same row and the same key from the same message.
function withReplyTo(message: RenderedEmail): RenderedEmail {
  return { ...message, replyTo: message.replyTo ?? supportEmail() };
}

// #1298 — a terminal cause (dead key, unverified domain) or no key at all is
// an "error" with a stable fingerprint so it pages once, not per warning.
function reportSendFailure(
  errObj: Error,
  emailType: string,
): { reason: string | null; notConfigured: boolean } {
  const notConfigured = errObj instanceof EmailNotConfiguredError;
  const reason = notConfigured
    ? "not_configured"
    : terminalSendReason(errObj.message);
  // Only emailType is tagged — the recipient address is PII.
  Sentry.captureException(errObj, {
    tags: { subsystem: "email", emailType },
    level: reason ? "error" : "warning",
    ...(reason && { fingerprint: ["email-send-terminal", reason] }),
  });
  return { reason, notConfigured };
}

/**
 * #474 — single persistence point for a failed Resend send. The message lands
 * in `FailedEmail` (PENDING, retry-now) for the worker to replay. Best-effort:
 * a failure here must not break the sender's non-throwing contract.
 */
export async function recordFailedEmail(
  message: RenderedEmail,
  emailType: string,
  sendError: unknown,
): Promise<void> {
  const errObj =
    sendError instanceof Error ? sendError : new Error(String(sendError));
  reportSendFailure(errObj, emailType);

  try {
    await prisma.failedEmail.create({
      data: {
        recipient: message.to,
        fromAddress: message.from,
        replyTo: message.replyTo ?? null,
        subject: message.subject,
        htmlBody: message.html,
        textBody: message.text ?? null,
        emailType,
        status: "PENDING",
        // Retry-now: the worker's first pass picks it up; backoff only kicks
        // in once a replay attempt itself fails.
        nextRetryAt: new Date(),
        lastError: errObj.message,
      },
    });
  } catch (persistError) {
    // The dead-letter insert itself failed — we've already lost the email;
    // taking down the caller too helps no one.
    console.error("[recordFailedEmail] persist failed:", persistError);
  }
}

/**
 * #1654 — phase one: write the rendered message as a PENDING `FailedEmail`
 * row BEFORE any send, so the email exists the moment the business change
 * commits. Inside a caller's transaction a failure propagates (the row and
 * the business write roll back together); outside one it is reported and
 * `null` is returned, and `attempt()` falls back to send-first.
 */
export async function stage(
  message: RenderedEmail,
  emailType: string,
  opts: StageOptions = {},
): Promise<StagedEmail | null> {
  const payload = withReplyTo(message);
  const idempotencyKey = idempotencyKeyFor(payload, emailType);
  const data = {
    recipient: payload.to,
    fromAddress: payload.from,
    replyTo: payload.replyTo ?? null,
    subject: payload.subject,
    htmlBody: payload.html,
    textBody: payload.text ?? null,
    emailType,
    status: "PENDING" as const,
    nextRetryAt: new Date(),
    lastError: null,
    entityRef: opts.entityRef ?? null,
  };
  if (opts.tx) {
    const row = await opts.tx.failedEmail.create({
      data,
      select: { id: true },
    });
    return { id: row.id, idempotencyKey };
  }
  try {
    const row = await prisma.failedEmail.create({ data, select: { id: true } });
    return { id: row.id, idempotencyKey };
  } catch (persistError) {
    console.error(`[email] ${emailType} stage failed:`, persistError);
    Sentry.captureException(
      persistError instanceof Error
        ? persistError
        : new Error(String(persistError)),
      { tags: { subsystem: "email", emailType }, level: "warning" },
    );
    return null;
  }
}

// AbortSignal.timeout rejects with a DOMException named TimeoutError; a
// caller-supplied signal aborts with AbortError. Either way: not a failure.
// Duck-typed on `name`: a DOMException is not `instanceof Error` in every realm.
function isAbort(error: unknown): boolean {
  const name =
    error && typeof error === "object"
      ? (error as { name?: unknown }).name
      : null;
  return name === "AbortError" || name === "TimeoutError";
}

// Best-effort row update: the send outcome is already decided, and the relay
// re-reads the row, so losing this write costs a duplicate Resend dedupes.
async function settleRow(
  staged: StagedEmail,
  emailType: string,
  data: Prisma.FailedEmailUpdateInput,
): Promise<void> {
  try {
    await prisma.failedEmail.update({ where: { id: staged.id }, data });
  } catch (updateError) {
    console.error(`[email] ${emailType} row update failed:`, updateError);
  }
}

/**
 * #1654 — phase two: one inline send under a time budget. Success marks the
 * row SENT with the Resend id; a terminal error dead-letters it; a transient
 * error leaves it PENDING with `lastError`; a timeout leaves it PENDING and
 * untouched (the relay finishes the job and the idempotency key makes a late
 * duplicate harmless). Never throws.
 */
export async function attempt(
  staged: StagedEmail | null,
  message: RenderedEmail,
  emailType: string,
  opts: { budgetMs: number },
): Promise<DeliverResult> {
  const payload = withReplyTo(message);
  const idempotencyKey =
    staged?.idempotencyKey ?? idempotencyKeyFor(payload, emailType);
  // Created here, not inline, so a send the SDK swallowed into a generic
  // "could not be resolved" error can still be recognised as our own abort.
  const signal = AbortSignal.timeout(opts.budgetMs);
  try {
    const client = getResendClient();
    if (!client) throw new EmailNotConfiguredError();

    // #1654 — the SDK's post() spreads these options into fetch, so the signal
    // really aborts a slow call; its option type just does not declare it.
    const data = await client.emails.send(payload, {
      idempotencyKey,
      signal,
    } as CreateEmailRequestOptions);
    // Resend resolves (does not throw) on API-level errors — a non-null
    // `error` must dead-letter, not report a false success.
    // #1298 — keep Resend's error name in the text: `validation_error` is what
    // classify.ts keys on, and a 4xx body rejection never succeeds on replay.
    if (data.error) {
      if (signal.aborted) {
        throw new DOMException(
          `send exceeded its ${opts.budgetMs} ms budget`,
          "TimeoutError",
        );
      }
      throw new Error(resendErrorText(data.error));
    }

    const resendId = data.data?.id ?? null;
    console.log(`[email] ${emailType} sent id=${resendId ?? "unknown"}`);
    if (staged) {
      await settleRow(staged, emailType, {
        status: "SENT",
        sentAt: new Date(),
        resendId,
        lastError: null,
      });
    }
    return { success: true, data };
  } catch (error) {
    if (isAbort(error)) {
      // Not a failure and not a page: the row is durable and the relay sends
      // it; only the request stopped waiting.
      console.warn(
        `[email] ${emailType} inline send timed out after ${opts.budgetMs} ms; left for the relay`,
      );
      if (!staged) await recordFailedEmail(payload, emailType, error);
      return { success: false, error, staged: staged !== null };
    }
    console.error(`[email] ${emailType} failed:`, error);
    if (!staged) {
      await recordFailedEmail(payload, emailType, error);
      return { success: false, error, staged: false };
    }
    const errObj = error instanceof Error ? error : new Error(String(error));
    const { reason, notConfigured } = reportSendFailure(errObj, emailType);
    // A missing key is terminal for the page, not for the row: it replays
    // once the key exists (#1298). A dead key or rejected body never will.
    await settleRow(
      staged,
      emailType,
      reason && !notConfigured
        ? { status: "DEAD_LETTER", lastError: errObj.message }
        : { lastError: errObj.message },
    );
    return { success: false, error, staged: true };
  }
}

/**
 * #1298 — the single send core every sender and job goes through. Never
 * throws: any failure (missing key included) dead-letters the rendered
 * message and returns `{ success: false }`.
 * #1654 — now `stage` + `attempt`: the row exists before the send. A caller
 * that owns a transaction calls the two phases itself, staging inside it and
 * attempting after commit, because an attempt inside the transaction would
 * send before the business write is durable.
 */
export async function deliver(
  message: RenderedEmail,
  emailType: string,
  opts: DeliverOptions = {},
): Promise<DeliverResult> {
  const staged = await stage(message, emailType, {
    entityRef: opts.entityRef,
  });
  return attempt(staged, message, emailType, {
    budgetMs: opts.budgetMs ?? EMAIL_BUDGET_MS.AUTH,
  });
}
