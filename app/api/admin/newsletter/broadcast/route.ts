/**
 * POST /api/admin/newsletter/broadcast
 *
 * Sends one newsletter through Resend's batch API (100 per call) to a filtered
 * audience of SUBSCRIBED addresses with a live MARKETING_COMMS consent, to the
 * calling admin only (`test`), or to the most recently confirmed N (`warmup`);
 * `preview` only counts. Every
 * message carries an unsubscribe footer and RFC 8058 one-click headers.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { getResendClient, SENDERS } from "@/lib/email";
import { createHash, randomUUID } from "node:crypto";
import { resendErrorText } from "@/lib/email/classify";
import { companyPostalAddress } from "@/lib/email/config";
import { heldRecipientDomain } from "@/lib/email/delivery-guard";
import { findSuppressed, normaliseEmail } from "@/lib/email/suppression";
import prisma from "@/lib/prisma";
import { stampFirstAttempt, UNSETTLED } from "@/lib/retry/provider-window";
import {
  AUDIENCE_TOO_LARGE_MESSAGE,
  BROADCAST_AUDIENCE_LIMIT,
  broadcastAudienceSchema,
} from "@/lib/newsletter/broadcast-audience";
import {
  listSendableSubscribers,
  withLiveMarketingConsent,
} from "@/lib/newsletter/service";
import { buildUnsubscribeUrl } from "@/lib/newsletter/tokens";

const message = {
  subject: z.string().trim().min(1, "Subject is required").max(200),
  htmlBody: z.string().min(1, "Email body is required"),
  textBody: z.string().optional(),
};
const audience = broadcastAudienceSchema.default({});

const requestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preview"), audience }),
  z.object({ mode: z.literal("test"), ...message }),
  z.object({
    mode: z.literal("warmup"),
    limit: z.number().int().min(1).max(BROADCAST_AUDIENCE_LIMIT),
    audience,
    ...message,
  }),
  z.object({ mode: z.literal("all"), audience, ...message }),
]);

type BroadcastRequest = z.infer<typeof requestSchema>;

const BATCH_SIZE = 100;

/** The addresses a request would send to after the consent ledger, suppression and the pre-launch hold. */
async function resolveRecipients(
  input: BroadcastRequest,
  adminEmail: string,
): Promise<{
  recipients: string[];
  matching: number;
  skippedNoConsent: number;
  skippedSuppressed: number;
  skippedHeld: number;
}> {
  const order = input.mode === "warmup" ? "recentFirst" : "stable";
  const subscribed =
    input.mode === "test"
      ? null
      : await listSendableSubscribers(input.audience, order);
  // A SUBSCRIBED row is mailable only while its MARKETING_COMMS artifact is live.
  const candidates = subscribed
    ? (await withLiveMarketingConsent(subscribed, new Date())).map(
        (s) => s.email,
      )
    : [normaliseEmail(adminEmail)];
  const matching = subscribed?.length ?? candidates.length;
  // A bounced or complaining address stays SUBSCRIBED only until the webhook settles it.
  const suppressed = await findSuppressed(candidates);
  const unsuppressed = candidates.filter((email) => !suppressed.has(email));
  const sendable = unsuppressed.filter(
    (email) => heldRecipientDomain(email) === null,
  );
  const skippedHeld = unsuppressed.length - sendable.length;
  if (skippedHeld > 0) {
    console.info("[email] held pre-launch", {
      event: "email.held_pre_launch",
      emailType: "NEWSLETTER_BROADCAST",
      held: skippedHeld,
    });
  }
  return {
    recipients:
      input.mode === "warmup" ? sendable.slice(0, input.limit) : sendable,
    matching,
    skippedNoConsent: matching - candidates.length,
    skippedSuppressed: candidates.length - unsuppressed.length,
    skippedHeld,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const {
      recipients,
      matching,
      skippedNoConsent,
      skippedSuppressed,
      skippedHeld,
    } = await resolveRecipients(input, auth.session.user.email);
    const counts = {
      matching,
      sendable: recipients.length,
      skippedNoConsent,
      skippedSuppressed,
      skippedHeld,
      limit: BROADCAST_AUDIENCE_LIMIT,
    };

    if (input.mode === "preview") return NextResponse.json(counts);

    if (recipients.length > BROADCAST_AUDIENCE_LIMIT) {
      return NextResponse.json(
        {
          error: AUDIENCE_TOO_LARGE_MESSAGE,
          code: "AUDIENCE_TOO_LARGE",
          ...counts,
        },
        { status: 422 },
      );
    }
    if (recipients.length === 0) {
      return NextResponse.json(
        { error: "No sendable recipients in this audience", ...counts },
        { status: 404 },
      );
    }

    const resend = getResendClient();
    if (!resend) {
      return NextResponse.json(
        { error: "Email service not configured (RESEND_API_KEY missing)" },
        { status: 503 },
      );
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      const emails = batch.map((email) =>
        buildMessage(email, input.subject, input.htmlBody, input.textBody),
      );

      const outcome = await sendBatch(
        resend,
        emails,
        input.mode === "test" ? randomUUID() : "",
      );
      if (outcome.ok) {
        sent += outcome.sent;
      } else {
        failed += batch.length;
        errors.push(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${outcome.error}`,
        );
      }
    }

    console.log(
      `[admin/newsletter/broadcast] mode=${input.mode} sent=${sent} failed=${failed} total=${recipients.length} skippedSuppressed=${skippedSuppressed} skippedHeld=${skippedHeld}`,
    );

    return NextResponse.json({
      success: true,
      mode: input.mode,
      sent,
      failed,
      total: recipients.length,
      skippedSuppressed,
      skippedHeld,
      ...(errors.length > 0 && { errors }),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "newsletter" } },
    );
    console.error("[admin/newsletter/broadcast]", error);
    return NextResponse.json(
      { error: "Failed to send the newsletter" },
      { status: 500 },
    );
  }
}

type BroadcastMessage = ReturnType<typeof buildMessage>;

function buildMessage(
  email: string,
  subject: string,
  htmlBody: string,
  textBody: string | undefined,
) {
  const unsubscribeUrl = buildUnsubscribeUrl(email);
  return {
    from: SENDERS.newsletter,
    to: email,
    subject,
    html: appendUnsubscribeFooter(htmlBody, unsubscribeUrl),
    text: textBody,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Sends one batch. The batch is a `FailedEmailBatch` row before the request
 * goes out, so a lost response or a failed send is replayed by the relay under
 * the same idempotency key. No per-message rows: a batch replay plus
 * per-message replays would send twice, since the two keys differ.
 */
async function sendBatch(
  resend: NonNullable<ReturnType<typeof getResendClient>>,
  emails: BroadcastMessage[],
  nonce: string,
): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  // One key per batch request, derived from its content like the
  // single-send path, so an admin re-submit inside 24 h cannot double-send.
  const idempotencyKey = batchIdempotencyKey(emails, nonce);
  const row = await prisma.failedEmailBatch.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      emailType: "NEWSLETTER_BROADCAST",
      payload: emails as Prisma.InputJsonValue,
      nextRetryAt: new Date(Date.now() + 60_000),
    },
    update: {},
    select: { id: true },
  });
  try {
    // Anchors the replay window on this request, not on the relay's first try.
    await stampFirstAttempt(prisma.failedEmailBatch, row.id, new Date());
    const result = await resend.batch.send(emails, {
      idempotencyKey,
    });
    if (result.error) {
      throw new Error(resendErrorText(result.error));
    }
    await settleBatch(row.id, {
      status: "SENT",
      sentAt: new Date(),
      lastError: null,
    });
    return { ok: true, sent: result.data?.data?.length ?? emails.length };
  } catch (batchError) {
    const error =
      batchError instanceof Error ? batchError.message : "Unknown error";
    // Left PENDING with the cause: the relay replays it on its next tick.
    await settleBatch(row.id, { lastError: error });
    return { ok: false, error };
  }
}

// Best-effort and conditional like deliver.ts's settleRow: a row the relay
// already settled is left alone, and a row left PENDING only costs a replay.
async function settleBatch(
  id: string,
  data: Prisma.FailedEmailBatchUpdateManyMutationInput,
): Promise<void> {
  try {
    await prisma.failedEmailBatch.updateMany({
      where: { id, status: UNSETTLED },
      data,
    });
  } catch (updateError) {
    console.error(
      "[admin/newsletter/broadcast] batch row update failed:",
      updateError,
    );
  }
}

function appendUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const line = `style="font-size:12px;color:#666;margin:10px 0;line-height:1.5"`;
  // Same postal line EmailFooter renders, so marketing mail carries it.
  const postalLine = `\n  <p ${line}>${escapeHtml(companyPostalAddress())}</p>`;
  const footer = `
<div style="text-align:center;margin:30px 0 0;padding:20px 0;border-top:1px solid #eee">
  <p ${line}>
    &copy; ${new Date().getFullYear()} Familiarise. All rights reserved.
  </p>${postalLine}
  <p ${line}>
    You received this because you subscribed to the Familiarise newsletter.
    <br/>
    <a href="${unsubscribeUrl}" style="color:#666;text-decoration:underline">Unsubscribe</a>
  </p>
</div>`;

  if (html.includes("</body>"))
    return html.replace("</body>", `${footer}</body>`);
  if (html.includes("</html>"))
    return html.replace("</html>", `${footer}</html>`);
  return html + footer;
}

// A test send carries a per-request nonce so a repeat test really sends.
function batchIdempotencyKey(
  emails: BroadcastMessage[],
  nonce: string,
): string {
  // Every field Resend compares (to, subject, html, text) per recipient, in
  // code-point order — a text-only correction must not collide for 24 h (409).
  const payloads = emails
    .map((e) => JSON.stringify([e.to, e.subject, e.html, e.text ?? ""]))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256")
    .update(nonce + payloads.join("\n"))
    .digest("hex");
  return `NEWSLETTER_BROADCAST/${digest.slice(0, 48)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
