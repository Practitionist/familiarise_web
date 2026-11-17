import * as Sentry from "@sentry/nextjs";
import {
  Resend,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
} from "resend";
import type { EmailSuppressionReason, Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { EMAIL_BUDGET_MS, supportEmail } from "./config";
import {
  REDACTED_CREDENTIAL_BODY,
  carriesCredential,
  resendErrorText,
  terminalSendReason,
} from "./classify";
import {
  deliveryColumns,
  emailPolicyRefusal,
  EmailPolicyRefusedError,
  type EmailDeliveryPolicy,
} from "./delivery-policy";
import { idempotencyKeyFor } from "./idempotency";
import { RENDER_FAILED } from "./replay-policy";
import { stampFirstAttempt, UNSETTLED } from "@/lib/retry/provider-window";
import { EmailRecipientCappedError, overRecipientCap } from "./recipient-cap";
import {
  EmailSuppressedError,
  findSuppressed,
  findSuppression,
  normaliseEmail,
  type SuppressionReader,
} from "./suppression";
import {
  EmailHeldError,
  HELD_PRE_LAUNCH,
  heldRecipientDomain,
  logHeld,
  recipientsOf,
} from "./delivery-guard";

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
  /** Stored on the row and rechecked before every send; never sent to Resend. */
  deliveryPolicy?: EmailDeliveryPolicy;
}

export type DeliverResult =
  | {
      success: true;
      data?: CreateEmailResponse;
      staged: boolean;
      stagedRow?: StagedEmail;
      stagedEmail?: StagedEmail;
    }
  | {
      success: false;
      error: unknown;
      staged?: boolean;
      stagedRow?: StagedEmail;
      stagedEmail?: StagedEmail;
    };

export interface StagedEmail {
  id: string;
  idempotencyKey: string;
  suppressed?: EmailSuppressionReason;
  held?: true;
}

export interface StageOptions {
  /** Stage inside the caller's transaction so a rollback takes the row too. */
  tx?: Pick<Tx, "failedEmail" | "emailSuppression">;
  /** `payment:<id>`, `user:<id>`, `newsletter:<email>`, `contact:<email>`. */
  entityRef?: string;
}

export interface DeliverOptions {
  entityRef?: string;
  /** Inline send budget; defaults to the auth budget, the most generous one. */
  budgetMs?: number;
  /** Persist to outbox (`stage`) and return immediately so `attempt()` runs post-response. */
  deferAttempt?: boolean;
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

/** The bodies the outbox row keeps; a live code or link never reaches the table. */
function storedBodies(
  message: RenderedEmail,
  emailType: string,
): { htmlBody: string; textBody: string | null } {
  if (carriesCredential(emailType)) {
    return { htmlBody: REDACTED_CREDENTIAL_BODY, textBody: null };
  }
  return { htmlBody: message.html, textBody: message.text ?? null };
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
        ...storedBodies(message, emailType),
        ...deliveryColumns(message.deliveryPolicy),
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
  const db = opts.tx ?? prisma;
  const write = async (): Promise<StagedEmail> => {
    const heldDomain = heldRecipientDomain(recipientsOf(payload));
    const suppressed = heldDomain
      ? undefined
      : (await findSuppression(payload.to, db))?.reason;
    const verdict = stagingVerdict(emailType, heldDomain, suppressed);
    const row = await db.failedEmail.create({
      data: stagedRowData(payload, emailType, verdict, opts.entityRef),
      select: { id: true },
    });
    return stagedEmailOf(row.id, payload, emailType, verdict);
  };
  if (opts.tx) return write();
  try {
    return await write();
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

/** Why a staged row is born DEAD_LETTER instead of PENDING: a pre-launch hold or a suppression. */
export interface StagingVerdict {
  held: boolean;
  suppressed?: EmailSuppressionReason;
}

/** A message with its verdict, read before the transaction that stages it. */
export interface ScreenedEmail {
  message: RenderedEmail;
  verdict: StagingVerdict;
}

function stagingVerdict(
  emailType: string,
  heldDomain: string | null,
  suppressed: EmailSuppressionReason | undefined,
): StagingVerdict {
  if (heldDomain) {
    logHeld(emailType, heldDomain);
    return { held: true };
  }
  if (suppressed) {
    console.warn(
      `[email] ${emailType} not sent: recipient is suppressed (${suppressed})`,
    );
    return { held: false, suppressed };
  }
  return { held: false };
}

function stagedRowData(
  payload: RenderedEmail,
  emailType: string,
  verdict: StagingVerdict,
  entityRef: string | undefined,
) {
  const refusal = verdict.held
    ? HELD_PRE_LAUNCH
    : verdict.suppressed
      ? `suppressed:${verdict.suppressed}`
      : null;
  return {
    recipient: payload.to,
    fromAddress: payload.from,
    replyTo: payload.replyTo ?? null,
    subject: payload.subject,
    ...storedBodies(payload, emailType),
    ...deliveryColumns(payload.deliveryPolicy),
    emailType,
    status: refusal ? ("DEAD_LETTER" as const) : ("PENDING" as const),
    nextRetryAt: new Date(Date.now() + 60_000),
    lastError: refusal,
    entityRef: entityRef ?? null,
  };
}

function stagedEmailOf(
  id: string,
  payload: RenderedEmail,
  emailType: string,
  verdict: StagingVerdict,
): StagedEmail {
  const idempotencyKey = idempotencyKeyFor(payload, emailType, id);
  if (verdict.held) return { id, idempotencyKey, held: true };
  return verdict.suppressed
    ? { id, idempotencyKey, suppressed: verdict.suppressed }
    : { id, idempotencyKey };
}

/** {@link stage}'s hold and suppression verdicts for `messages`, in one read. */
export async function screenForStaging(
  messages: RenderedEmail[],
  emailType: string,
  db?: SuppressionReader,
): Promise<ScreenedEmail[]> {
  const payloads = messages.map(withReplyTo);
  const heldDomains = payloads.map((payload) =>
    heldRecipientDomain(recipientsOf(payload)),
  );
  const suppressed = await findSuppressed(
    payloads.filter((_, i) => !heldDomains[i]).map((payload) => payload.to),
    db,
  );
  return payloads.map((payload, i) => ({
    message: messages[i],
    verdict: stagingVerdict(
      emailType,
      heldDomains[i],
      heldDomains[i] ? undefined : suppressed.get(normaliseEmail(payload.to)),
    ),
  }));
}

/** Stages screened messages inside `tx` in one insert, in their order. */
export async function stageScreened(
  tx: Pick<Tx, "failedEmail">,
  screened: ScreenedEmail[],
  emailType: string,
  entityRef: string,
): Promise<StagedEmail[]> {
  if (screened.length === 0) return [];
  const payloads = screened.map(({ message }) => withReplyTo(message));
  const rows = await tx.failedEmail.createManyAndReturn({
    data: payloads.map((payload, i) =>
      stagedRowData(payload, emailType, screened[i].verdict, entityRef),
    ),
    select: { id: true, recipient: true },
  });
  // Rows are matched back by recipient; one address's rows keep insert order.
  const idsByRecipient = new Map<string, string[]>();
  for (const row of rows) {
    idsByRecipient.set(row.recipient, [
      ...(idsByRecipient.get(row.recipient) ?? []),
      row.id,
    ]);
  }
  return payloads.map((payload, i) => {
    const id = idsByRecipient.get(payload.to)?.shift();
    if (!id) throw new Error(`[email] ${emailType} staged row missing`);
    return stagedEmailOf(id, payload, emailType, screened[i].verdict);
  });
}

/** The recipient of a message whose template threw before it could be staged. */
export interface UnrenderedEmail {
  from: string;
  to: string;
  deliveryPolicy?: EmailDeliveryPolicy;
}

/**
 * Records, inside `tx`, a required message that failed to render: a body-less
 * `DEAD_LETTER` row that Needs attention lists and replay refuses.
 */
export async function stageRenderFailure(
  tx: Pick<Tx, "failedEmail">,
  unrendered: UnrenderedEmail,
  emailType: string,
  entityRef: string | null,
): Promise<void> {
  await tx.failedEmail.create({
    data: {
      recipient: unrendered.to,
      fromAddress: unrendered.from,
      subject: `Not rendered: ${emailType}`,
      htmlBody: "",
      textBody: null,
      ...deliveryColumns(unrendered.deliveryPolicy),
      emailType,
      status: "DEAD_LETTER",
      lastError: RENDER_FAILED,
      entityRef,
    },
    select: { id: true },
  });
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

// Best-effort and conditional: a row the relay already settled is left alone,
// and a lost write only costs a duplicate that Resend's key dedupes.
async function settleRow(
  staged: StagedEmail,
  emailType: string,
  data: Prisma.FailedEmailUpdateManyMutationInput,
): Promise<void> {
  try {
    await prisma.failedEmail.updateMany({
      where: { id: staged.id, status: UNSETTLED },
      data,
    });
  } catch (updateError) {
    console.error(`[email] ${emailType} row update failed:`, updateError);
  }
}

/**
 * Rereads the account policy and suppression just before a send; null means
 * send. A refusal dead-letters the row; a failed read leaves it pending (no
 * send) for the relay, which runs the same recheck.
 */
async function recheckRecipient(
  staged: StagedEmail | null,
  payload: RenderedEmail,
  emailType: string,
): Promise<DeliverResult | null> {
  let refusal: EmailPolicyRefusedError | EmailSuppressedError | null = null;
  try {
    const policy = await emailPolicyRefusal(
      payload.deliveryPolicy ?? null,
      payload.to,
      prisma,
    );
    if (policy) {
      refusal = new EmailPolicyRefusedError(policy);
    } else {
      const suppression = await findSuppression(payload.to, prisma);
      if (suppression) refusal = new EmailSuppressedError(suppression.reason);
    }
  } catch (readError) {
    console.error(`[email] ${emailType} recipient recheck failed:`, readError);
    if (!staged) {
      await recordFailedEmail(payload, emailType, readError);
      return { success: false, error: readError, staged: false };
    }
    const reason =
      readError instanceof Error ? readError.message : String(readError);
    await settleRow(staged, emailType, {
      lastError: `recipient recheck failed: ${reason}`,
    });
    return { success: false, error: readError, staged: true };
  }
  if (!refusal) return null;
  console.warn(`[email] ${emailType} not sent: ${refusal.message}`);
  if (staged) {
    await settleRow(staged, emailType, {
      status: "DEAD_LETTER",
      lastError: refusal.message,
    });
  }
  return { success: false, error: refusal, staged: staged !== null };
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
  // #1647 — the row is already DEAD_LETTER; the refusal is the intended
  // outcome, so no send, no row write and no Sentry.
  if (staged?.suppressed) {
    return {
      success: false,
      error: new EmailSuppressedError(staged.suppressed),
      staged: true,
    };
  }
  // A held message never reaches Resend; an unstaged one is logged here instead.
  if (staged?.held) {
    return { success: false, error: new EmailHeldError(), staged: true };
  }
  const heldDomain = heldRecipientDomain(recipientsOf(message));
  if (heldDomain) {
    if (!staged) logHeld(emailType, heldDomain);
    return {
      success: false,
      error: new EmailHeldError(),
      staged: staged !== null,
    };
  }
  const payload = withReplyTo(message);
  const refused = await recheckRecipient(staged, payload, emailType);
  if (refused) return refused;
  const { deliveryPolicy: _policy, ...wirePayload } = payload;
  const idempotencyKey =
    staged?.idempotencyKey ?? idempotencyKeyFor(payload, emailType);
  // Created here, not inline, so a send the SDK swallowed into a generic
  // "could not be resolved" error can still be recognised as our own abort.
  const signal = AbortSignal.timeout(opts.budgetMs);
  try {
    const client = getResendClient();
    if (!client) throw new EmailNotConfiguredError();
    // Inline attempts follow staging in the same request, so no window check here.
    if (staged) {
      await stampFirstAttempt(prisma.failedEmail, staged.id, new Date());
    }

    // #1654 — the SDK's post() spreads these options into fetch, so the signal
    // really aborts a slow call; its option type just does not declare it.
    const data = await client.emails.send(wirePayload, {
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
    return { success: true, data, staged: staged !== null };
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
 * Auth mail past its per-recipient daily cap is dropped before staging
 * (`recipient-cap.ts`).
 */
export async function deliver(
  message: RenderedEmail,
  emailType: string,
  opts: DeliverOptions = {},
): Promise<DeliverResult> {
  if (await overRecipientCap(message.to, emailType)) {
    console.warn(
      JSON.stringify({ event: "email_recipient_capped", emailType }),
    );
    return { success: false, error: new EmailRecipientCappedError() };
  }
  const staged = await stage(message, emailType, {
    entityRef: opts.entityRef,
  });
  if (opts.deferAttempt && staged) {
    if (staged.suppressed) {
      return {
        success: false,
        error: new EmailSuppressedError(staged.suppressed),
        staged: true,
      };
    }
    if (staged.held) {
      return { success: false, error: new EmailHeldError(), staged: true };
    }
    return {
      success: true,
      staged: true,
      stagedRow: staged,
      stagedEmail: staged,
    };
  }
  return attempt(staged, message, emailType, {
    budgetMs: opts.budgetMs ?? EMAIL_BUDGET_MS.AUTH,
  });
}
