import * as Sentry from "@sentry/nextjs";
import { Resend, type CreateEmailResponse } from "resend";
import prisma from "@/lib/prisma";
import { supportEmail } from "./config";
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
}

export type DeliverResult =
  | { success: true; data: CreateEmailResponse }
  | { success: false; error: unknown };

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
  // Only emailType is tagged — the recipient address is PII.
  // #1298 — a terminal cause (dead key, unverified domain) or no key at all is
  // an "error" with a stable fingerprint so it pages once, not per warning.
  const reason =
    sendError instanceof EmailNotConfiguredError
      ? "not_configured"
      : terminalSendReason(errObj.message);
  Sentry.captureException(errObj, {
    tags: { subsystem: "email", emailType },
    level: reason ? "error" : "warning",
    ...(reason && { fingerprint: ["email-send-terminal", reason] }),
  });

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
 * #1298 — the single send core every sender and job goes through. Never
 * throws: any failure (missing key included) dead-letters the rendered
 * message and returns `{ success: false }`.
 */
export async function deliver(
  message: RenderedEmail,
  emailType: string,
): Promise<DeliverResult> {
  // Customers reply to a real mailbox unless the sender chose its own
  // (the contact inquiry keeps the visitor's address).
  const payload: RenderedEmail = {
    ...message,
    replyTo: message.replyTo ?? supportEmail(),
  };
  try {
    const idempotencyKey = idempotencyKeyFor(payload, emailType);
    const client = getResendClient();
    if (!client) throw new EmailNotConfiguredError();

    const data = await client.emails.send(payload, { idempotencyKey });
    // Resend resolves (does not throw) on API-level errors — a non-null
    // `error` must dead-letter, not report a false success.
    // #1298 — keep Resend's error name in the text: `validation_error` is what
    // classify.ts keys on, and a 4xx body rejection never succeeds on replay.
    if (data.error) throw new Error(resendErrorText(data.error));

    console.log(`[email] ${emailType} sent id=${data.data?.id ?? "unknown"}`);
    return { success: true, data };
  } catch (error) {
    console.error(`[email] ${emailType} failed:`, error);
    await recordFailedEmail(payload, emailType, error);
    return { success: false, error };
  }
}
